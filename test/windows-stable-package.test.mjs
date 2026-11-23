import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  buildPackage, dependencyPlan, inventory, parseIntegrity, platformMatches,
  qualificationGate, readTarGzip, safeRelativePath, sha256, TRANSPORT_REVISION,
  verifyIntegrity,
} from '../scripts/windows/stable/build-package.mjs';
import { verifyOrExtract } from '../scripts/windows/stable/installer/Unpack-Payload.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const integrity = bytes => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;

function tar(entries) {
  const pieces = [];
  for (const { name, bytes = Buffer.from('payload'), type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((n, x) => n + x, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    pieces.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  pieces.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(pieces));
}

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, bytes); central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

test('Windows member paths reject traversal, drive/ADS, reserved names and aliases', () => {
  for (const bad of ['../escape', '/absolute', 'C:/drive', 'a\\b', 'a:stream', 'foo/../x', 'foo//x', 'NUL.txt', 'a/COM1', 'trailing.', 'trailing ', 'é'.normalize('NFD')]) assert.throws(() => safeRelativePath(bad), /Unsafe/);
  assert.equal(safeRelativePath('node_modules/@scope/name/dist/file.js'), 'node_modules/@scope/name/dist/file.js');
});

test('archive integrity pins reject altered bytes and malformed/fallback digests', () => {
  const good = Buffer.from('known bytes'), sri = integrity(good);
  assert.doesNotThrow(() => verifyIntegrity(good, sri));
  assert.throws(() => verifyIntegrity(Buffer.from('changed bytes'), sri), /mismatch/);
  assert.throws(() => parseIntegrity(`${sri} sha256-Zm9v`), /unsupported/);
  assert.throws(() => parseIntegrity('sha512-Zm9v'), /Malformed/);
});

test('platform filtering respects exclusions and rejects incompatible mandatory packages', () => {
  assert.equal(platformMatches(['!linux'], 'win32'), true);
  assert.equal(platformMatches(['win32', '!win32'], 'win32'), false);
  const digest = integrity(Buffer.from('anything'));
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: digest, os: ['linux'], optional: true }, 'node_modules/example/node_modules/child': { version: '1.0.0', resolved: 'https://registry.npmjs.org/child/-/child-1.0.0.tgz', integrity: digest } } };
  assert.deepEqual(dependencyPlan(lock, { packages: [] }).excluded.map(e => e.reason), ['platform', 'excluded-parent']);
  lock.packages['node_modules/example'].optional = false;
  assert.throws(() => dependencyPlan(lock, { packages: [] }), /Required package/);
});

test('missing integrity needs an exact authoritative supplementary pin', () => {
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } } };
  assert.throws(() => dependencyPlan(lock, { packages: [] }), /integrity/);
  const supplement = { packages: [{ package: 'example', version: '1.0.0', integrity: integrity(Buffer.from('anything')), registryMetadata: 'https://registry.npmjs.org/example/1.0.0', tarball: lock.packages['node_modules/example'].resolved }] };
  assert.equal(dependencyPlan(lock, supplement).included.length, 1);
  supplement.packages[0].version = '1.0.1';
  assert.throws(() => dependencyPlan(lock, supplement), /integrity/);
});

test('tar reader refuses escapes, links, case duplicates, corrupt headers and trailing data', () => {
  assert.equal(readTarGzip(tar([{ name: 'package/package.json' }]))[0].path, 'package.json');
  assert.equal(readTarGzip(tar([{ name: 'node v22.19/./package.json' }]))[0].path, 'package.json');
  for (const name of ['package/../../outside', 'outside', 'package/C:/outside']) assert.throws(() => readTarGzip(tar([{ name }])), /Unsafe|prefix/);
  assert.throws(() => readTarGzip(tar([{ name: 'package/file' }, { name: 'other/second' }])), /Mixed/);
  for (const type of ['1', '2', '3', '4', '6']) assert.throws(() => readTarGzip(tar([{ name: 'package/link', type }])), /refused/);
  assert.throws(() => readTarGzip(tar([{ name: 'package/File' }, { name: 'package/file' }])), /Duplicate/);
  const repeated = tar([{ name: 'package/./file' }, { name: 'package/file' }]);
  assert.throws(() => readTarGzip(repeated), /Duplicate/);
  const deduplicated = readTarGzip(repeated, { allowIdenticalDuplicates: true });
  assert.equal(deduplicated.length, 1);
  assert.deepEqual(deduplicated.identicalDuplicateMembers, ['file']);
  assert.throws(() => readTarGzip(tar([{ name: 'package/file', bytes: Buffer.from('one') }, { name: 'package/file', bytes: Buffer.from('two') }]), { allowIdenticalDuplicates: true }), /Duplicate/);
  assert.throws(() => readTarGzip(tar([{ name: 'package/File' }, { name: 'package/file' }]), { allowIdenticalDuplicates: true }), /Duplicate/);
  const raw = zlib.gunzipSync(tar([{ name: 'package/file' }])); raw[0] ^= 1;
  assert.throws(() => readTarGzip(zlib.gzipSync(raw)), /checksum/);
  assert.throws(() => readTarGzip(zlib.gzipSync(Buffer.concat([Buffer.alloc(1024), Buffer.from('hidden')]))), /after tar end/);
});

test('inventory rejects symlinks and hardlinks instead of reading outside its tree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codas-package-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'normal'), 'bytes');
  fs.symlinkSync('normal', path.join(root, 'linked'));
  assert.throws(() => inventory(root), /Symlink/);
  fs.unlinkSync(path.join(root, 'linked'));
  fs.linkSync(path.join(root, 'normal'), path.join(root, 'hardlinked'));
  assert.throws(() => inventory(root), /Hardlinked/);
});

const gateContext = { mode: 'stable', transportRevision: TRANSPORT_REVISION, manifestSha256: 'a'.repeat(64), sourceFiles: [{ path: 'src/agent.js', sha256: 'b'.repeat(64) }], installerFiles: [{ path: 'INSTALL.cmd', sha256: 'c'.repeat(64) }] };
function qualifiedReport() {
  return {
    schemaVersion: 1, stable: true, status: 'passed', transportRevision: TRANSPORT_REVISION,
    policy: { id: 'windows-daily-use', authorizedOn: '2026-11-23', fixedDurationRequired: false },
    manifestSha256: gateContext.manifestSha256, sourceFiles: gateContext.sourceFiles, installerFiles: gateContext.installerFiles,
    transportTests: { reconnectAttempts: 20, reconnectPassed: 20, blackholeAttempts: 2, blackholePassed: 2, blackholeDurationMs: 85_000, maxAdmittedSseConsumers: 1, staleMutationsExecuted: 0, commandFailures: 0, unexpectedErrors: 0, manualInterventions: 0, sourceHashesVerified: true, measurementHashesVerified: true, evidence: ['transport.json'] },
    soak: { mode: 'cumulative-awake', qualifiedAwakeMs: 3_600_000, qualifiedIdleAwakeMs: 600_000, naturalWake: { observedCount: 0, recoveredCount: 0, coverage: 'not-observed', maxAwakeRecoveryMs: null } },
    fullPcReboot: { status: 'not-tested', evidence: [] },
    installation: { environment: 'physical-windows', actualPackageTested: true, ...Object.fromEntries(['windowsPowerShell51', 'payloadNativeSmoke', 'isolatedFreshInstall', 'installedProbe', 'stopRestartRecovery', 'taskRestartRecovery', 'delayedNetworkRecovery', 'dependencyLossEvidence', 'dependencyCorruptionRefused', 'dependencyRepair', 'upgradeRollback', 'authorizedFolderRemoteExecution'].map(name => [name, true])), evidence: ['installation.json'] },
    evidence: [{ name: 'transport.json', sha256: 'd'.repeat(64) }, { name: 'installation.json', sha256: 'e'.repeat(64) }],
  };
}

test('daily-use policy permits honest unobserved wake/reboot and removes fixed-duration thresholds', () => {
  const report = qualifiedReport();
  const passed = qualificationGate(report, gateContext);
  assert.equal(passed.stable, true);
  assert.equal(passed.policy.id, 'windows-daily-use');
  assert.equal(passed.supplementary.naturalWake.coverage, 'not-observed');
  assert.equal(passed.supplementary.fullPcReboot.status, 'not-tested');
  report.soak.qualifiedAwakeMs = report.soak.qualifiedIdleAwakeMs = 0;
  assert.equal(qualificationGate(report, gateContext).stable, true);
  report.soak.naturalWake = { observedCount: 1, recoveredCount: 1, coverage: 'observed', maxAwakeRecoveryMs: 5000, evidence: ['transport.json'] };
  report.fullPcReboot = { status: 'passed', evidence: ['installation.json'] };
  assert.equal(qualificationGate(report, gateContext).stable, true);
  assert.equal(qualificationGate(report, { ...gateContext, mode: 'candidate' }).stable, false);
  assert.equal(qualificationGate(null, { ...gateContext, mode: 'candidate' }).stable, false);
});

test('daily-use stable gate rejects wrong policy, missing actual Windows gates, old bytes and failed observations', () => {
  for (const mutate of [
    r => { delete r.policy; }, r => { r.policy.id = 'unit-tests-only'; },
    r => { r.policy.authorizedOn = '2026-11-22'; }, r => { r.policy.fixedDurationRequired = true; },
    r => { r.transportRevision = 'e'.repeat(40); }, r => { r.manifestSha256 = 'e'.repeat(64); },
    r => { r.sourceFiles = []; }, r => { r.installerFiles = []; },
    r => { r.transportTests.reconnectPassed = 19; }, r => { r.transportTests.blackholeAttempts = r.transportTests.blackholePassed = 1; },
    r => { r.transportTests.staleMutationsExecuted = 1; }, r => { r.transportTests.commandFailures = 1; }, r => { r.transportTests.maxAdmittedSseConsumers = 2; },
    r => { r.transportTests.evidence = ['missing.json']; }, r => { r.installation.environment = 'linux-fixture'; },
    r => { r.installation.actualPackageTested = false; },
    r => { r.soak.naturalWake.observedCount = 1; }, r => { r.soak.naturalWake.maxAwakeRecoveryMs = 0; },
    r => { r.soak.naturalWake = { observedCount: 1, recoveredCount: 0, coverage: 'observed', maxAwakeRecoveryMs: 90_001, evidence: ['transport.json'] }; },
    r => { r.soak.qualifiedAwakeMs = Infinity; }, r => { r.soak.qualifiedIdleAwakeMs = r.soak.qualifiedAwakeMs + 1; },
    r => { r.fullPcReboot.status = 'failed'; }, r => { r.fullPcReboot.status = 'passed'; },
    r => { r.evidence = []; }, r => { r.evidence[0].sha256 = ''; },
    ...['windowsPowerShell51', 'payloadNativeSmoke', 'isolatedFreshInstall', 'installedProbe', 'stopRestartRecovery', 'taskRestartRecovery', 'delayedNetworkRecovery', 'dependencyLossEvidence', 'dependencyCorruptionRefused', 'dependencyRepair', 'upgradeRollback', 'authorizedFolderRemoteExecution'].map(gate => r => { delete r.installation[gate]; }),
  ]) { const r = qualifiedReport(); mutate(r); assert.throws(() => qualificationGate(r, gateContext)); }
});

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codas-package-fixture-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'source'), cache = path.join(temporary, 'cache');
  fs.mkdirSync(path.join(root, 'dependencies'), { recursive: true });
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  const store = (bytes, algorithm = 'sha512') => {
    const hash = crypto.createHash(algorithm).update(bytes).digest('hex');
    fs.mkdirSync(path.join(cache, algorithm), { recursive: true });
    fs.writeFileSync(path.join(cache, algorithm, hash), bytes);
    return hash;
  };
  const cli = Buffer.from('// exact fixture CLI\n');
  const devspace = tar([{ name: 'package/package.json', bytes: json({ name: '@waishnav/devspace', version: '1.1.0-beta.4' }) }, { name: 'package/dist/cli.js', bytes: cli }]);
  const sqlite = tar([{ name: 'package/package.json', bytes: json({ name: 'better-sqlite3', version: '12.11.1' }) }]);
  store(devspace); store(sqlite);
  const lock = { name: 'fixture', lockfileVersion: 3, packages: { '': { dependencies: { '@waishnav/devspace': '1.1.0-beta.4' } }, 'node_modules/@waishnav/devspace': { version: '1.1.0-beta.4', integrity: integrity(devspace), resolved: 'https://registry.npmjs.org/@waishnav/devspace/-/devspace-1.1.0-beta.4.tgz' }, 'node_modules/better-sqlite3': { version: '12.11.1', integrity: integrity(sqlite), resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz' } } };
  const lockBytes = json(lock), exe = Buffer.from('fixture EXE'), license = Buffer.from('fixture license'), native = Buffer.from('fixture native');
  const nodeZip = zip([['node-v22.23.3-win-x64/node.exe', exe], ['node-v22.23.3-win-x64/LICENSE', license]]);
  const nativeArchive = tar([{ name: 'build/Release/better_sqlite3.node', bytes: native }]);
  const pins = { schemaVersion: 1, target: { platform: 'win32', architecture: 'x64', nodeAbi: '127' }, transportRevision: TRANSPORT_REVISION, lockSha256: sha256(lockBytes), node: { version: '22.23.3', archiveUrl: 'https://nodejs.org/fixture.zip', archiveSha256: store(nodeZip, 'sha256'), executableSha256: sha256(exe), licenseSha256: sha256(license) }, devspace: { version: '1.1.0-beta.4', integrity: integrity(devspace), cliSha256: sha256(cli) }, betterSqlite3: { version: '12.11.1', archiveUrl: 'https://github.com/fixture.tar.gz', archiveSha256: store(nativeArchive, 'sha256'), binaryPath: 'build/Release/better_sqlite3.node', binarySha256: sha256(native) } };
  fs.writeFileSync(path.join(root, 'dependencies/windows-devspace-package-lock.json'), lockBytes);
  fs.writeFileSync(path.join(root, 'dependencies/npm-integrity-supplement.json'), json({ schemaVersion: 1, packages: [] }));
  fs.writeFileSync(path.join(root, 'dependencies/windows-runtime-pins.json'), json(pins));
  for (const [directory, files] of [['runtime', ['supervisor.mjs', 'control.mjs', 'init-state.mjs', 'probe.mjs', 'Hold-RuntimeLock.ps1']], ['installer', ['Install-CodasSol.ps1', 'Verify-Payload.ps1', 'Payload-Tool.mjs']]]) {
    fs.mkdirSync(path.join(root, 'scripts/windows/stable', directory), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(root, 'scripts/windows/stable', directory, file), `// fixture ${file}\n`);
  }
  fs.writeFileSync(path.join(root, 'scripts/windows/stable/INSTALL.cmd'), '@echo off\r\n');
  fs.copyFileSync(path.join(repositoryRoot, 'scripts/windows/stable/installer/Unpack-Payload.mjs'), path.join(root, 'scripts/windows/stable/installer/Unpack-Payload.mjs'));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'fixture license\n');
  return { root, cache, temporary, pins };
}

test('offline fixture bundle is reproducible, hashes all bytes and uses original frozen Git source', async t => {
  const f = fixture(t);
  const first = path.join(f.temporary, 'first'), second = path.join(f.temporary, 'second');
  const a = await buildPackage({ ...f, output: first, mode: 'candidate', offline: true });
  const b = await buildPackage({ ...f, output: second, mode: 'candidate', offline: true });
  assert.equal(a.manifestSha256, b.manifestSha256);
  assert.deepEqual(inventory(first), inventory(second));
  const release = JSON.parse(fs.readFileSync(path.join(first, 'release.json')));
  assert.equal(release.qualification.stable, false);
  assert.equal(release.sourceFiles.length, 22);
  const source = execFileSync('git', ['show', `${TRANSPORT_REVISION}:src/agent.js`], { cwd: repositoryRoot });
  assert.deepEqual(fs.readFileSync(path.join(first, 'payload/router/agent.js')), source);
  const manifest = JSON.parse(fs.readFileSync(path.join(first, 'payload-manifest.json')));
  assert.deepEqual(manifest.files, inventory(path.join(first, 'payload')));
  await assert.rejects(buildPackage({ ...f, output: first, mode: 'candidate', offline: true }), /already exists/);
});

test('build refuses release mislabelling, changed lock and corrupt cached dependencies', async t => {
  const f = fixture(t), output = path.join(f.temporary, 'rejected');
  await assert.rejects(buildPackage({ ...f, output, offline: true }), /explicit/);
  await assert.rejects(buildPackage({ ...f, output, mode: 'candidate', versionId: 'windows-0.2.0', offline: true }), /visibly/);
  const nodeArchive = path.join(f.cache, 'sha256', f.pins.node.archiveSha256);
  fs.appendFileSync(nodeArchive, 'tamper');
  await assert.rejects(buildPackage({ ...f, output, mode: 'candidate', offline: true }), /integrity mismatch/);
  assert.equal(fs.existsSync(output), false);
  fs.appendFileSync(path.join(f.root, 'dependencies/windows-devspace-package-lock.json'), ' ');
  await assert.rejects(buildPackage({ ...f, output, mode: 'candidate', offline: true }), /provenance mismatch/);
});

test('stable assembly uses exact candidate payload/installer pins and rejects incomplete daily-use evidence', async t => {
  // Synthetic fixtures exercise the gate; they are never physical-PC evidence.
  const f = fixture(t), candidate = path.join(f.temporary, 'candidate-for-qualification');
  await buildPackage({ ...f, output: candidate, mode: 'candidate', packed: true, offline: true });
  const release = JSON.parse(fs.readFileSync(path.join(candidate, 'release.json')));
  const report = { ...qualifiedReport(), manifestSha256: release.manifestSha256, sourceFiles: release.sourceFiles, installerFiles: release.installerFiles };
  const qualification = path.join(f.temporary, 'synthetic-qualified-report.json');
  fs.writeFileSync(qualification, json(report));
  const output = path.join(f.temporary, 'stable-fixture');
  const result = await buildPackage({ ...f, qualification, output, mode: 'stable', versionId: 'windows-0.2.0', packed: true, offline: true });
  assert.equal(result.qualification.stable, true);
  assert.equal(result.manifestSha256, release.manifestSha256);
  assert.deepEqual(fs.readFileSync(path.join(output, 'payload.codas')), fs.readFileSync(path.join(candidate, 'payload.codas')));
  assert.equal(fs.existsSync(path.join(output, 'qualification-pending.json')), false);
  delete report.installation.dependencyRepair;
  fs.writeFileSync(qualification, json(report));
  const refused = path.join(f.temporary, 'refused-stable');
  await assert.rejects(buildPackage({ ...f, qualification, output: refused, mode: 'stable', versionId: 'windows-0.2.0', packed: true, offline: true }), /dependencyRepair/);
  assert.equal(fs.existsSync(refused), false);
});

test('compact package verifies and extracts exact payload without exposing long dependency paths in the outer bundle', async t => {
  const f = fixture(t), output = path.join(f.temporary, 'compact');
  const built = await buildPackage({ ...f, output, mode: 'candidate', packed: true, offline: true });
  assert.equal(fs.existsSync(path.join(output, 'payload')), false);
  assert.equal(fs.existsSync(path.join(output, 'bootstrap/node.exe')), true);
  assert.equal(verifyOrExtract({ packageRoot: output, verifyOnly: true }).files, built.payloadFiles);
  const installRoot = path.join(f.temporary, 'installed'), target = path.join(installRoot, 'versions/test/payload');
  assert.equal(verifyOrExtract({ packageRoot: output, target, installRoot }).ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'payload-manifest.json')));
  assert.deepEqual(inventory(target), manifest.files);
  assert.throws(() => verifyOrExtract({ packageRoot: output, target, installRoot }), /absent or empty/);
  assert.throws(() => verifyOrExtract({ packageRoot: output, target: path.join(f.temporary, 'outside/payload'), installRoot }), /authorized install root/);
  const archive = path.join(output, 'payload.codas');
  const bytes = fs.readFileSync(archive); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(archive, bytes);
  assert.throws(() => verifyOrExtract({ packageRoot: output, verifyOnly: true }), /archive digest/);
});

test('packed extractor rejects forged index/manifest traversal, overlapping extents and extra archive data before writes', async t => {
  const f = fixture(t), output = path.join(f.temporary, 'compact-invalid');
  await buildPackage({ ...f, output, mode: 'candidate', packed: true, offline: true });
  const releasePath = path.join(output, 'release.json'), indexPath = path.join(output, 'payload-index.json'), manifestPath = path.join(output, 'payload-manifest.json');
  const originalRelease = JSON.parse(fs.readFileSync(releasePath)), originalIndex = JSON.parse(fs.readFileSync(indexPath)), originalManifest = JSON.parse(fs.readFileSync(manifestPath));
  function resetAndMutate(mutate) {
    const release = structuredClone(originalRelease), index = structuredClone(originalIndex), manifest = structuredClone(originalManifest);
    mutate({ release, index, manifest });
    const indexBytes = json(index), manifestBytes = json(manifest);
    release.payloadArchive.indexSha256 = sha256(indexBytes); release.manifestSha256 = sha256(manifestBytes);
    fs.writeFileSync(indexPath, indexBytes); fs.writeFileSync(manifestPath, manifestBytes); fs.writeFileSync(releasePath, json(release));
  }
  resetAndMutate(({ index }) => { index.files[1].offset = index.files[0].offset; });
  assert.throws(() => verifyOrExtract({ packageRoot: output, verifyOnly: true }), /does not match/);
  resetAndMutate(({ index, manifest }) => { index.files[0].path = manifest.files[0].path = '../outside'; });
  assert.throws(() => verifyOrExtract({ packageRoot: output, verifyOnly: true }), /Unsafe/);
  resetAndMutate(({ release }) => { release.payloadArchive.size++; });
  assert.throws(() => verifyOrExtract({ packageRoot: output, verifyOnly: true }), /Unindexed/);
  resetAndMutate(({ index, manifest }) => { index.files[0].size = manifest.files[0].size = 4_000_000_000; });
  assert.throws(() => verifyOrExtract({ packageRoot: output, verifyOnly: true }), /size/);
});
