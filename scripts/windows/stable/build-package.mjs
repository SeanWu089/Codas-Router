#!/usr/bin/env node
/**
 * Rebuild an offline Windows bundle from frozen Git objects and pinned upstream
 * archives. Never reads an installed runtime, credentials, profiles or user state.
 * No lifecycle hook is executed. Packaging proves bytes, not Windows operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const TRANSPORT_REVISION = 'c1497cac73c8d147dfcd74127018be470ae8a72a';
export const DEFAULT_VERSION = 'windows-0.2.0-rc.5-c1497ca';
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '../../..');
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const PAYLOAD_MAGIC = Buffer.from('CODAS-PAYLOAD-V1\n', 'ascii');
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || value.includes('\\') || value.includes('\0')) throw new Error(`Unsafe relative path: ${JSON.stringify(value)}`);
  if (value.startsWith('/') || value.includes(':') || /[\x00-\x1f<>"|?*]/.test(value)) throw new Error(`Unsafe Windows path: ${value}`);
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe Windows path component: ${value}`);
  return value;
}

function makeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  let current = path.resolve(directory);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink directory refused: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function writeFresh(root, relative, bytes) {
  safeRelativePath(relative);
  const target = path.join(root, ...relative.split('/'));
  makeDirectory(path.dirname(target));
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
}

export function inventory(root) {
  const result = [];
  const seen = new Set();
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = safeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const lowered = relative.toLowerCase();
      if (seen.has(lowered)) throw new Error(`Case-insensitive duplicate: ${relative}`);
      seen.add(lowered);
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) {
        const st = fs.lstatSync(full);
        if (st.nlink !== 1) throw new Error(`Hardlinked file refused: ${relative}`);
        result.push({ path: relative, sha256: sha256(fs.readFileSync(full)), size: st.size });
      } else throw new Error(`Non-regular payload member: ${relative}`);
    }
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Inventory root is a symlink');
  visit(root, '');
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function parseIntegrity(integrity) {
  // One exact strongest digest is intentional: no downgrade to an alternate hash.
  const match = /^sha(512|256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || '');
  if (!match) throw new Error('Missing or unsupported pinned integrity');
  const algorithm = `sha${match[1]}`;
  const expected = Buffer.from(match[2], 'base64');
  if (expected.length !== Number(match[1]) / 8 || expected.toString('base64') !== match[2]) throw new Error('Malformed pinned integrity');
  return { algorithm, expected, hex: expected.toString('hex') };
}

export function verifyIntegrity(bytes, integrity) {
  const { algorithm, expected } = parseIntegrity(integrity);
  const actual = crypto.createHash(algorithm).update(bytes).digest();
  if (!crypto.timingSafeEqual(actual, expected)) throw new Error('Archive integrity mismatch');
}

const sha256Integrity = hex => {
  if (!/^[a-f0-9]{64}$/.test(hex || '')) throw new Error('Invalid SHA-256 pin');
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;
};

export function platformMatches(list, target) {
  if (!list) return true;
  if (!Array.isArray(list) || list.some(x => typeof x !== 'string')) throw new Error('Invalid package platform constraint');
  if (list.includes(`!${target}`)) return false;
  const positive = list.filter(x => !x.startsWith('!'));
  return positive.length === 0 || positive.includes(target) || positive.includes('any');
}

const nameFromLockPath = p => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);

export function dependencyPlan(lock, supplement) {
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) throw new Error('Expected complete npm v3 lock');
  const supplemental = new Map((supplement.packages || []).map(e => [`${e.package}@${e.version}`, e]));
  const included = [], excluded = [];
  const seenPaths = new Set();
  for (const [p, entry] of Object.entries(lock.packages).filter(([p]) => p).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    safeRelativePath(p);
    if (!p.startsWith('node_modules/') || entry.link || !entry.version) throw new Error(`Unpinned dependency: ${p}`);
    if (seenPaths.has(p.toLowerCase())) throw new Error(`Duplicate dependency path: ${p}`);
    seenPaths.add(p.toLowerCase());
    const name = nameFromLockPath(p);
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid package name: ${name}`);
    const excludedAncestor = excluded.some(e => p.startsWith(`${e.path}/node_modules/`));
    if (excludedAncestor || !platformMatches(entry.os, 'win32') || !platformMatches(entry.cpu, 'x64')) {
      if (!entry.optional && !excludedAncestor) throw new Error(`Required package does not support Windows x64: ${name}`);
      excluded.push({ path: p, name, version: entry.version, reason: excludedAncestor ? 'excluded-parent' : 'platform' });
      continue;
    }
    const supplementalEntry = supplemental.get(`${name}@${entry.version}`);
    const integrity = entry.integrity || supplementalEntry?.integrity;
    parseIntegrity(integrity);
    if (!entry.integrity && (!supplementalEntry?.registryMetadata?.startsWith('https://registry.npmjs.org/') || !supplementalEntry.tarball)) throw new Error(`Unverified supplemental integrity: ${name}`);
    const url = new URL(entry.resolved);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || !['registry.npmjs.org', 'registry.npmmirror.com'].includes(url.hostname)) throw new Error(`Non-registry dependency source: ${name}`);
    const officialUrl = new URL(url); officialUrl.hostname = 'registry.npmjs.org';
    included.push({ path: p, name, version: entry.version, integrity, lockedUrl: url.href, officialUrl: officialUrl.href, hasInstallScript: Boolean(entry.hasInstallScript) });
  }
  return { included, excluded };
}

function tarNumber(bytes, description) {
  if (bytes[0] & 0x80) throw new Error(`Unsupported binary tar ${description}`);
  const text = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`Invalid tar ${description}`);
  const number = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid tar ${description}`);
  return number;
}

function paxFields(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space < offset) throw new Error('Invalid PAX record');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Invalid PAX length');
    const length = Number(lengthText), end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw new Error('Truncated PAX record');
    const record = bytes.subarray(space + 1, end - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal <= 0) throw new Error('Invalid PAX key/value');
    const key = record.slice(0, equal);
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate PAX key: ${key}`);
    if (key.startsWith('GNU.sparse')) throw new Error('Sparse archives refused');
    fields[key] = record.slice(equal + 1);
    offset = end;
  }
  return fields;
}

/** Parse verified tar bytes without following links or permitting Windows aliases. */
export function readTarGzip(archive, { npm = true, allowIdenticalDuplicates = false } = {}) {
  const bytes = zlib.gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  const files = [], seen = new Map();
  files.identicalDuplicateMembers = [];
  let nextPax = {}, globalPax = {}, longName, npmPrefix;
  const text = b => b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString('utf8');
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('Non-zero data after tar end');
      return files;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (tarNumber(header.subarray(148, 156), 'checksum') !== checksum) throw new Error('Tar header checksum mismatch');
    let name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
    const type = String.fromCharCode(header[156] || 48);
    const fields = { ...globalPax, ...nextPax };
    let size = tarNumber(header.subarray(124, 136), 'size');
    if (fields.size !== undefined && !['x', 'g', 'L'].includes(type)) {
      if (!/^(0|[1-9][0-9]*)$/.test(fields.size)) throw new Error('Invalid PAX size');
      size = Number(fields.size);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES || offset + 512 + size > bytes.length) throw new Error('Truncated or oversized tar member');
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextPax = paxFields(content); continue; }
    if (type === 'g') { globalPax = { ...globalPax, ...paxFields(content) }; continue; }
    if (type === 'L') { longName = text(content).replace(/\n$/, ''); continue; }
    name = (fields.path || longName || name).replace(/^(\.\/)+/, '');
    nextPax = {}; longName = undefined;
    // npm strips one top-level archive directory. DefinitelyTyped historically
    // uses names such as "node v22.19/", while other packages use "package/./".
    // Permit these equivalent forms without ever normalizing away a '..'.
    let relative = name;
    if (npm) {
      const slash = name.indexOf('/');
      if (slash < 0) {
        if (type !== '5') throw new Error(`Missing npm archive directory prefix: ${name}`);
        safeRelativePath(name);
        continue;
      }
      const prefix = safeRelativePath(name.slice(0, slash));
      if (npmPrefix !== undefined && npmPrefix !== prefix) throw new Error(`Mixed npm archive prefixes: ${prefix}`);
      npmPrefix = prefix;
      relative = name.slice(slash + 1).replace(/^(\.\/)+/, '');
    }
    if (type === '5') {
      const directory = relative.replace(/\/$/, '');
      if (npm && !directory) continue;
      safeRelativePath(directory);
      continue;
    }
    if (type !== '0') throw new Error(`Tar links/special entries refused: ${name} (${type})`);
    name = safeRelativePath(relative);
    const prior = seen.get(name.toLowerCase());
    if (prior) {
      // A few pinned npm archives repeat both package/./dist/index.js and
      // package/dist/index.js with identical bytes. Canonicalize only this
      // provably idempotent case, report it, and reject case aliases/conflicts.
      if (!allowIdenticalDuplicates || prior.path !== name || !prior.bytes.equals(content)) throw new Error(`Duplicate tar member: ${name}`);
      files.identicalDuplicateMembers.push(name);
      continue;
    }
    seen.set(name.toLowerCase(), { path: name, bytes: content });
    files.push({ path: name, bytes: content });
  }
  throw new Error('Missing tar terminator');
}

/** Only extract named Node distribution members after verifying the whole ZIP. */
export function readZipMembers(archive, requested) {
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
  }
  if (end < 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP layout');
  const count = archive.readUInt16LE(end + 10), centralLength = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  if (count === 0xffff || offset + centralLength !== end || archive.readUInt16LE(end + 8) !== count) throw new Error('ZIP64/multipart layout refused');
  const found = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20), uncompressed = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extra + comment;
    if (!requested.includes(name)) continue;
    if (found.has(name) || flags & 1 || ![0, 8].includes(method) || uncompressed > MAX_ARCHIVE_BYTES) throw new Error('Unsupported/duplicate ZIP member');
    if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const localNameLength = archive.readUInt16LE(local + 26), localExtraLength = archive.readUInt16LE(local + 28);
    if (archive.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw new Error('ZIP member name mismatch');
    const start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > end) throw new Error('Truncated ZIP member');
    const member = archive.subarray(start, start + compressed);
    const bytes = method === 0 ? member : zlib.inflateRawSync(member, { maxOutputLength: MAX_ARCHIVE_BYTES });
    if (bytes.length !== uncompressed) throw new Error('ZIP member size mismatch');
    found.set(name, bytes);
  }
  if (found.size !== requested.length) throw new Error('Required ZIP member missing');
  return found;
}

function validateDailyUseReport(report) {
  if (!report || report.schemaVersion !== 1 || report.status !== 'passed' || report.stable !== true) throw new Error('Stable qualification report missing or not passed');
  const policy = report.policy;
  if (policy?.id !== 'windows-daily-use' || policy.authorizedOn !== '2026-11-23' || policy.fixedDurationRequired !== false) throw new Error('Qualification must use the explicitly authorized windows-daily-use policy');
  if (!Array.isArray(report.evidence) || !report.evidence.length) throw new Error('Qualification evidence inventory is missing');
  const evidence = new Set();
  for (const item of report.evidence) {
    if (!item || typeof item.name !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw new Error('Qualification evidence needs a name and SHA-256');
    safeRelativePath(item.name);
    const key = item.name.toLowerCase();
    if (evidence.has(key)) throw new Error('Duplicate qualification evidence name');
    evidence.add(key);
  }
  const evidenceFor = (references, label, required = true) => {
    if (!Array.isArray(references) || (required && !references.length) || references.some(name => typeof name !== 'string' || !evidence.has(name.toLowerCase())) || new Set(references).size !== references.length) throw new Error(`Missing or unknown ${label} evidence reference`);
  };
  const transport = report.transportTests;
  if (!transport || !Number.isSafeInteger(transport.reconnectAttempts) || transport.reconnectAttempts < 20 || transport.reconnectPassed !== transport.reconnectAttempts || !Number.isSafeInteger(transport.blackholeAttempts) || transport.blackholeAttempts < 2 || transport.blackholePassed !== transport.blackholeAttempts || !Number.isFinite(transport.blackholeDurationMs) || transport.blackholeDurationMs < 85_000) throw new Error('Frozen transport reconnect/blackhole qualification is incomplete');
  for (const field of ['staleMutationsExecuted', 'commandFailures', 'unexpectedErrors', 'manualInterventions']) if (transport[field] !== 0) throw new Error(`Transport ${field} must be verified zero`);
  if (transport.maxAdmittedSseConsumers !== 1 || transport.sourceHashesVerified !== true || transport.measurementHashesVerified !== true) throw new Error('Frozen-source single-consumer measurement qualification missing');
  evidenceFor(transport.evidence, 'transport');
  const installation = report.installation;
  if (installation?.environment !== 'physical-windows' || installation.actualPackageTested !== true) throw new Error('Actual packaged payload must be tested on physical Windows');
  const gates = ['windowsPowerShell51', 'payloadNativeSmoke', 'isolatedFreshInstall', 'installedProbe', 'stopRestartRecovery', 'taskRestartRecovery', 'delayedNetworkRecovery', 'dependencyLossEvidence', 'dependencyCorruptionRefused', 'dependencyRepair', 'upgradeRollback', 'authorizedFolderRemoteExecution'];
  for (const gate of gates) if (installation[gate] !== true) throw new Error(`Windows installation qualification incomplete: ${gate}`);
  evidenceFor(installation.evidence, 'physical Windows installation');
  // Fixed duration was explicitly waived by the user on 2026-11-23. Keep the
  // measured awake/idle duration, wake coverage and reboot coverage visible;
  // absence of supplementary observations is not a fabricated passing test.
  const soak = report.soak;
  if (!soak || soak.mode !== 'cumulative-awake' || !Number.isFinite(soak.qualifiedAwakeMs) || !Number.isFinite(soak.qualifiedIdleAwakeMs) || soak.qualifiedAwakeMs < 0 || soak.qualifiedIdleAwakeMs < 0 || soak.qualifiedIdleAwakeMs > soak.qualifiedAwakeMs) throw new Error('Supplementary awake/idle observations are invalid');
  if (soak.status !== undefined && !['supplementary', 'passed', 'in-progress', 'not-observed'].includes(soak.status)) throw new Error('Supplementary observation records a failure');
  for (const field of ['staleMutationsExecuted', 'commandFailures', 'unexpectedErrors', 'manualInterventions']) if (soak[field] !== undefined && soak[field] !== 0) throw new Error(`Supplementary observation ${field} records a failure`);
  const wake = soak.naturalWake;
  if (!wake || !Number.isSafeInteger(wake.observedCount) || !Number.isSafeInteger(wake.recoveredCount) || wake.observedCount < 0 || wake.recoveredCount < 0 || wake.recoveredCount > wake.observedCount || !['observed', 'not-observed'].includes(wake.coverage)) throw new Error('Explicit natural-wake coverage is missing');
  if (wake.coverage === 'not-observed') {
    if (wake.observedCount !== 0 || wake.recoveredCount !== 0 || wake.maxAwakeRecoveryMs !== null) throw new Error('Unobserved wake must not claim a recovery measurement');
    if (wake.evidence !== undefined) evidenceFor(wake.evidence, 'unobserved wake', false);
  } else {
    if (wake.observedCount < 1 || wake.recoveredCount !== wake.observedCount || !Number.isFinite(wake.maxAwakeRecoveryMs) || wake.maxAwakeRecoveryMs < 0 || wake.maxAwakeRecoveryMs > 90_000) throw new Error('Observed natural-wake recovery failed');
    evidenceFor(wake.evidence, 'natural wake');
  }
  const reboot = report.fullPcReboot;
  if (!reboot || !['not-tested', 'passed'].includes(reboot.status)) throw new Error('Explicit full-PC reboot coverage is missing or failed');
  evidenceFor(reboot.evidence, 'full-PC reboot', reboot.status === 'passed');
  if (reboot.status === 'not-tested' && reboot.evidence.length) throw new Error('An untested reboot must not claim passing evidence');
}

export function qualificationGate(report, { mode, transportRevision, manifestSha256, sourceFiles, installerFiles }) {
  if (mode === 'candidate') return { stable: false, status: 'candidate', reason: 'Physical Windows usage-scenario acceptance is separate from packaging; extended awake time, natural wake and full-PC reboot remain supplementary observations.' };
  if (mode !== 'stable') throw new Error('Qualification requires explicit candidate or stable mode');
  validateDailyUseReport(report);
  if (transportRevision !== TRANSPORT_REVISION || report.transportRevision !== transportRevision || !/^[a-f0-9]{64}$/.test(manifestSha256 || '') || report.manifestSha256 !== manifestSha256) throw new Error('Qualification does not match these exact payload bytes');
  if (!Array.isArray(sourceFiles) || !sourceFiles.length || !Array.isArray(installerFiles) || !installerFiles.length || JSON.stringify(report.sourceFiles) !== JSON.stringify(sourceFiles) || JSON.stringify(report.installerFiles) !== JSON.stringify(installerFiles)) throw new Error('Qualification does not match exact source/installer bytes');
  return { stable: true, status: 'passed', reportSha256: sha256(jsonBytes(report)), policy: report.policy, supplementary: { mode: 'cumulative-awake', qualifiedAwakeMs: report.soak.qualifiedAwakeMs, qualifiedIdleAwakeMs: report.soak.qualifiedIdleAwakeMs, naturalWake: report.soak.naturalWake, fullPcReboot: report.fullPcReboot } };
}

function cacheFile(cache, integrity) {
  const { algorithm, hex } = parseIntegrity(integrity);
  return path.join(cache, algorithm, hex);
}

async function cachedArchive({ cache, integrity, urls, offline }) {
  const target = cacheFile(cache, integrity);
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error('Invalid cache member');
    verifyIntegrity(fs.readFileSync(target), integrity);
    return target;
  }
  if (offline) throw new Error(`Pinned archive is absent from offline cache: ${parseIntegrity(integrity).hex}`);
  makeDirectory(path.dirname(target));
  const errors = [];
  for (const url of urls) {
    const temporary = `${target}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > MAX_ARCHIVE_BYTES ? new Error('Archive exceeds maximum size') : null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      verifyIntegrity(fs.readFileSync(temporary), integrity);
      fs.renameSync(temporary, target);
      return target;
    } catch (error) { errors.push(`${new URL(url).host}: ${error.message}`); fs.rmSync(temporary, { force: true }); }
  }
  throw new Error(`Could not retrieve pinned archive (${errors.join('; ')})`);
}

function loadInputs(root) {
  const dependencyDir = path.join(root, 'dependencies');
  const lockBytes = fs.readFileSync(path.join(dependencyDir, 'windows-devspace-package-lock.json'));
  const pins = readJson(path.join(dependencyDir, 'windows-runtime-pins.json'));
  if (pins.schemaVersion !== 1 || pins.transportRevision !== TRANSPORT_REVISION || pins.lockSha256 !== sha256(lockBytes)) throw new Error('Dependency lock/pin provenance mismatch');
  const lock = JSON.parse(lockBytes);
  const supplement = readJson(path.join(dependencyDir, 'npm-integrity-supplement.json'));
  const plan = dependencyPlan(lock, supplement);
  const devspace = plan.included.find(e => e.path === 'node_modules/@waishnav/devspace');
  const sqlite = plan.included.find(e => e.path === 'node_modules/better-sqlite3');
  if (devspace?.version !== pins.devspace.version || devspace?.integrity !== pins.devspace.integrity || sqlite?.version !== pins.betterSqlite3.version) throw new Error('DevSpace/native lock versions do not match pins');
  return { pins, lock, supplement, plan };
}

export async function prepareDependencies(options) {
  const { pins, plan } = loadInputs(options.root || repositoryRoot);
  const unique = [...new Map(plan.included.map(e => [e.integrity, e])).values()];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < unique.length) {
      const entry = unique[next++];
      const urls = options.officialOnly ? [entry.officialUrl] : [...new Set([entry.lockedUrl, entry.officialUrl])];
      await cachedArchive({ ...options, integrity: entry.integrity, urls });
      done++;
      if (done % 50 === 0 || done === unique.length) options.progress?.(`Pinned npm archives verified: ${done}/${unique.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await cachedArchive({ ...options, integrity: sha256Integrity(pins.node.archiveSha256), urls: [pins.node.archiveUrl] });
  await cachedArchive({ ...options, integrity: sha256Integrity(pins.betterSqlite3.archiveSha256), urls: [pins.betterSqlite3.archiveUrl] });
  return { packages: plan.included.length, excludedPlatformPackages: plan.excluded.length, uniqueArchives: unique.length };
}

function frozenSources(root) {
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', TRANSPORT_REVISION, '--', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (listing.length !== 22 || listing.some(p => !/^src\/[a-zA-Z0-9._-]+\.js$/.test(p))) throw new Error('Frozen source inventory differs from the reviewed 22 modules');
  return listing.map(p => {
    const bytes = execFileSync('git', ['show', `${TRANSPORT_REVISION}:${p}`], { cwd: root, maxBuffer: 5 * 1024 * 1024 });
    return { path: p, bytes, sha256: sha256(bytes) };
  });
}

function copySourceDirectory(from, toRoot, prefix, allowedExtension) {
  const files = inventory(from);
  if (!files.length) throw new Error(`Required source directory is empty: ${from}`);
  for (const item of files) {
    if (!allowedExtension.test(item.path)) throw new Error(`Unexpected source file in release directory: ${item.path}`);
    const bytes = fs.readFileSync(path.join(from, ...item.path.split('/')));
    if (sha256(bytes) !== item.sha256) throw new Error(`Source changed during packaging: ${item.path}`);
    writeFresh(toRoot, `${prefix}/${item.path}`, bytes);
  }
  if (JSON.stringify(inventory(from)) !== JSON.stringify(files)) throw new Error(`Source directory changed during packaging: ${prefix}`);
}

function publicLock(lock, supplement, plan) {
  const out = structuredClone(lock);
  out.name = 'codas-windows-devspace';
  out.packages[''] = { name: out.name, version: '1.0.0', dependencies: { '@waishnav/devspace': '1.1.0-beta.4' } };
  for (const entry of plan.included) out.packages[entry.path].integrity = entry.integrity;
  return out;
}

export function packPayload(packageRoot, manifest) {
  const archivePath = path.join(packageRoot, 'payload.codas');
  const fd = fs.openSync(archivePath, 'wx', 0o644);
  const digest = crypto.createHash('sha256');
  const index = { schemaVersion: 1, format: 'codas-payload-v1', files: [] };
  let offset = 0;
  const append = bytes => {
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
    offset += bytes.length; digest.update(bytes);
  };
  try {
    append(PAYLOAD_MAGIC);
    for (const file of manifest.files) {
      safeRelativePath(file.path);
      const bytes = fs.readFileSync(path.join(packageRoot, 'payload', ...file.path.split('/')));
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Payload changed during archive creation: ${file.path}`);
      const compressed = zlib.deflateRawSync(bytes, { level: 6 });
      const useCompressed = compressed.length < bytes.length;
      const stored = useCompressed ? compressed : bytes;
      index.files.push({ path: file.path, sha256: file.sha256, size: file.size, offset, compressedSize: stored.length, compression: useCompressed ? 'deflate-raw' : 'store' });
      append(stored);
    }
  } finally { fs.closeSync(fd); }
  const indexBytes = jsonBytes(index);
  writeFresh(packageRoot, 'payload-index.json', indexBytes);
  return { format: 'codas-payload-v1', path: 'payload.codas', indexPath: 'payload-index.json', sha256: digest.digest('hex'), indexSha256: sha256(indexBytes), size: offset };
}

export async function buildPackage(options) {
  if (!['candidate', 'stable'].includes(options.mode)) throw new Error('Choose explicit --candidate or --stable; default publishing is forbidden');
  const versionId = options.versionId || DEFAULT_VERSION;
  if (!/^windows-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(versionId) || versionId.includes('..')) throw new Error('Unsafe versionId');
  if (options.mode === 'candidate' && !/-rc\.[0-9]+(?:-|$)/.test(versionId)) throw new Error('Candidate version must visibly include -rc.N');
  if (options.mode === 'stable' && /rc\.|preview|candidate/i.test(versionId)) throw new Error('Stable version must not use a candidate label');
  const root = options.root || repositoryRoot;
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error('Output already exists; refusing to overwrite any previous artifact');
  const { pins, lock, supplement, plan } = loadInputs(root);
  const sources = frozenSources(root);
  const sourceFiles = sources.map(({ path: p, sha256: hash }) => ({ path: p, sha256: hash }));
  const stableReport = options.mode === 'stable' ? readJson(options.qualification || '') : null;
  // Reject an incomplete stable request before expensive downloads or extraction.
  if (options.mode === 'stable') validateDailyUseReport(stableReport);
  await prepareDependencies({ ...options, root });
  const staging = `${output}.building-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  makeDirectory(staging);
  try {
    const payload = path.join(staging, 'payload'); makeDirectory(payload);
    const nodeArchive = fs.readFileSync(cacheFile(options.cache, sha256Integrity(pins.node.archiveSha256)));
    verifyIntegrity(nodeArchive, sha256Integrity(pins.node.archiveSha256));
    const nodePrefix = `node-v${pins.node.version}-win-x64/`;
    const nodeMembers = readZipMembers(nodeArchive, [`${nodePrefix}node.exe`, `${nodePrefix}LICENSE`]);
    for (const [name, expected] of [['node.exe', pins.node.executableSha256], ['LICENSE', pins.node.licenseSha256]]) {
      const bytes = nodeMembers.get(`${nodePrefix}${name}`);
      if (sha256(bytes) !== expected) throw new Error(`Node ${name} pin mismatch`);
      writeFresh(payload, `node/${name}`, bytes);
    }
    const provenance = [];
    for (const dependency of plan.included) {
      const archive = fs.readFileSync(cacheFile(options.cache, dependency.integrity));
      verifyIntegrity(archive, dependency.integrity);
      const members = readTarGzip(archive, { allowIdenticalDuplicates: true });
      const packageJson = members.find(f => f.path === 'package.json');
      if (!packageJson) throw new Error(`Package metadata missing: ${dependency.name}`);
      const metadata = JSON.parse(packageJson.bytes.toString('utf8'));
      if (metadata.name !== dependency.name || metadata.version !== dependency.version) throw new Error(`Package name/version differs from lock: ${dependency.name}`);
      for (const member of members) writeFresh(payload, `devspace/${dependency.path}/${member.path}`, member.bytes);
      const licenseFiles = members.filter(f => /(?:^|\/)(licen[sc]e|copying|notice|third.?party)[^\/]*$/i.test(f.path)).map(f => ({ path: f.path, sha256: sha256(f.bytes) }));
      provenance.push({ path: dependency.path, name: dependency.name, version: dependency.version, integrity: dependency.integrity, source: dependency.officialUrl, fileCount: members.length, archiveSha256: sha256(archive), declaredLicense: metadata.license || metadata.licenses || null, licenseFiles, identicalTarMembersCanonicalized: members.identicalDuplicateMembers, lifecycleExecuted: false });
    }
    const nativeArchive = fs.readFileSync(cacheFile(options.cache, sha256Integrity(pins.betterSqlite3.archiveSha256)));
    verifyIntegrity(nativeArchive, sha256Integrity(pins.betterSqlite3.archiveSha256));
    const nativeMembers = readTarGzip(nativeArchive, { npm: false });
    if (nativeMembers.length !== 1 || nativeMembers[0].path !== pins.betterSqlite3.binaryPath || sha256(nativeMembers[0].bytes) !== pins.betterSqlite3.binarySha256) throw new Error('Unexpected better-sqlite3 native prebuild');
    writeFresh(payload, `devspace/node_modules/better-sqlite3/${pins.betterSqlite3.binaryPath}`, nativeMembers[0].bytes);
    const cli = path.join(payload, 'devspace/node_modules/@waishnav/devspace/dist/cli.js');
    if (sha256(fs.readFileSync(cli)) !== pins.devspace.cliSha256) throw new Error('DevSpace CLI pin mismatch');
    writeFresh(payload, 'devspace/package.json', jsonBytes({ name: 'codas-windows-devspace', version: '1.0.0', private: true, dependencies: { '@waishnav/devspace': pins.devspace.version } }));
    writeFresh(payload, 'devspace/package-lock.json', jsonBytes(publicLock(lock, supplement, plan)));
    writeFresh(payload, 'devspace/dependency-provenance.json', jsonBytes({ schemaVersion: 1, target: pins.target, originalLockSha256: pins.lockSha256, npmLifecycleScriptsExecuted: false, packages: provenance, excludedPlatformPackages: plan.excluded, node: pins.node, betterSqlite3: pins.betterSqlite3, supplementalIntegrity: supplement.packages }));
    for (const source of sources) writeFresh(payload, `router/${path.posix.basename(source.path)}`, source.bytes);
    writeFresh(payload, 'router/package.json', jsonBytes({ name: 'codas-windows-transport', version: '0.2.0', private: true, type: 'module', transportRevision: TRANSPORT_REVISION }));
    copySourceDirectory(path.join(root, 'scripts/windows/stable/runtime'), payload, 'runtime', /\.(mjs|ps1)$/);
    for (const required of ['runtime/supervisor.mjs', 'runtime/control.mjs', 'runtime/init-state.mjs', 'runtime/probe.mjs']) if (!fs.existsSync(path.join(payload, required))) throw new Error(`Runtime source incomplete: ${required}`);
    copySourceDirectory(path.join(root, 'scripts/windows/stable/installer'), staging, 'installer', /\.(ps1|mjs)$/);
    for (const required of ['Install-CodasSol.ps1', 'Verify-Payload.ps1', 'Payload-Tool.mjs']) if (!fs.existsSync(path.join(staging, 'installer', required))) throw new Error(`Installer source incomplete: ${required}`);
    const launcher = fs.readFileSync(path.join(root, 'scripts/windows/stable/INSTALL.cmd'));
    writeFresh(staging, 'INSTALL.cmd', launcher);
    writeFresh(staging, 'LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
    const licenseInventory = provenance.map(({ path: p, name, version, declaredLicense, licenseFiles, source, archiveSha256 }) => ({ path: `payload/devspace/${p}`, name, version, declaredLicense, licenseFiles, source, archiveSha256 }));
    writeFresh(staging, 'THIRD-PARTY-LICENSES.json', jsonBytes({ schemaVersion: 1, nodeLicense: 'bootstrap/LICENSE (packed distribution) and payload/node/LICENSE (installed)', packages: licenseInventory }));
    writeFresh(staging, 'THIRD-PARTY-NOTICES.md', Buffer.from([
      '# Third-party software notices', '',
      'The Codas project license does not relicense bundled third-party software.',
      'All upstream license, copyright and NOTICE files are preserved with their packages in the payload. No upstream executable or source file is modified.',
      'The Node distribution license and its embedded third-party notices are retained as bootstrap/LICENSE and payload/node/LICENSE.', '',
      '## Anthropic components', '',
      'The pinned @anthropic-ai/claude-agent-sdk and its Windows binary package carry custom Anthropic terms, not the MIT license. Their original LICENSE.md files are preserved.',
      'Official terms: https://code.claude.com/docs/en/legal-and-compliance and https://www.anthropic.com/legal/commercial-terms .',
      'The official preinstallation conditions require the unmodified binary and its authentication methods to remain intact. End users use their own applicable provider credentials; this bundle supplies no Claude account, subscription, shared API key, usage allowance or resale service.',
      'The SDK license terms are also described at https://code.claude.com/docs/en/agent-sdk/overview .', '',
      '## Complete inventory', '',
      'THIRD-PARTY-LICENSES.json lists every included locked package, declared license, upstream archive digest, and all identified license/NOTICE paths. The complete original files, including notices embedded in source files, remain in the payload.',
      'Installed dependency integrity and provenance are recorded in payload/devspace/dependency-provenance.json. Bundled native artifacts are tied to the same pinned upstream sources.', '',
    ].join('\n')));
    for (const name of ['README-WINDOWS.md', ...(options.mode === 'candidate' ? ['qualification-pending.json'] : [])]) {
      const source = path.join(root, 'scripts/windows/stable', name);
      if (fs.existsSync(source)) writeFresh(staging, name, fs.readFileSync(source));
    }
    const payloadToolSha256 = sha256(fs.readFileSync(path.join(staging, 'installer/Payload-Tool.mjs')));
    const manifest = { schemaVersion: 1, payloadToolSha256, files: inventory(payload) };
    const manifestBytes = jsonBytes(manifest), manifestSha256 = sha256(manifestBytes);
    writeFresh(staging, 'payload-manifest.json', manifestBytes);
    let payloadArchive;
    if (options.packed) {
      if (!fs.existsSync(path.join(staging, 'installer/Unpack-Payload.mjs'))) throw new Error('Packed payload extractor is missing');
      for (const name of ['node.exe', 'LICENSE']) writeFresh(staging, `bootstrap/${name}`, fs.readFileSync(path.join(payload, 'node', name)));
      payloadArchive = packPayload(staging, manifest);
    }
    const installerFiles = [
      ...inventory(path.join(staging, 'installer')).map(f => ({ path: `installer/${f.path}`, sha256: f.sha256 })),
      { path: 'INSTALL.cmd', sha256: sha256(launcher) },
      ...(options.packed ? inventory(path.join(staging, 'bootstrap')).map(f => ({ path: `bootstrap/${f.path}`, sha256: f.sha256 })) : []),
    ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const qualification = qualificationGate(stableReport, { mode: options.mode, transportRevision: TRANSPORT_REVISION, manifestSha256, sourceFiles, installerFiles });
    const release = { schemaVersion: 1, versionId, transportRevision: TRANSPORT_REVISION, manifestSha256, installerFiles, qualification, sourceFiles, ...(payloadArchive ? { payloadArchive } : {}) };
    writeFresh(staging, 'release.json', jsonBytes(release));
    if (stableReport) writeFresh(staging, 'qualification.json', jsonBytes(stableReport));
    if (options.packed) {
      // Check the public extractor against the finished package before dropping
      // the build-only tree; installation never relies on Explorer's long paths.
      const { verifyOrExtract } = await import('./installer/Unpack-Payload.mjs');
      verifyOrExtract({ packageRoot: staging, verifyOnly: true });
      fs.rmSync(payload, { recursive: true });
    }
    // All files are a deterministic function of reviewed inputs; mtimes are not proof.
    const epoch = Number(execFileSync('git', ['show', '-s', '--format=%ct', TRANSPORT_REVISION], { cwd: root, encoding: 'utf8' }).trim());
    for (const item of inventory(staging)) fs.utimesSync(path.join(staging, item.path), epoch, epoch);
    fs.renameSync(staging, output);
    return { output, versionId, qualification, transportRevision: TRANSPORT_REVISION, manifestSha256, payloadFiles: manifest.files.length, payloadBytes: manifest.files.reduce((sum, f) => sum + f.size, 0), npmPackages: provenance.length, excludedPlatformPackages: plan.excluded.length, ...(payloadArchive ? { payloadArchive } : {}) };
  } catch (error) {
    // The failed directory is owned by this exact build and was created fresh.
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  const options = { root: repositoryRoot, cache: path.join(repositoryRoot, '.release-cache'), packed: true, progress: line => process.stderr.write(line + '\n') };
  let prepare = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--candidate' || option === '--stable') {
      if (options.mode) throw new Error('Specify exactly one release mode');
      options.mode = option.slice(2);
    } else if (option === '--prepare-dependencies') prepare = true;
    else if (option === '--unpacked') options.packed = false;
    else if (option === '--offline') options.offline = true;
    else if (option === '--official-only') options.officialOnly = true;
    else if (['--output', '--cache', '--version', '--qualification'].includes(option)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${option} value`);
      options[{ '--output': 'output', '--cache': 'cache', '--version': 'versionId', '--qualification': 'qualification' }[option]] = args[++i];
    } else if (option === '--help') {
      process.stdout.write('Build compact offline package: node scripts/windows/stable/build-package.mjs --candidate --output <new-directory> --cache <archive-cache> [--offline]\nUnpacked engineering fixtures only: add --unpacked.\nPrepare archives only: --prepare-dependencies --cache <archive-cache> [--official-only]\nStable: --stable --version windows-0.2.0 --qualification <passed-report.json> --output <new-directory>\nNo install scripts run. A candidate is not a stable release.\n');
      return;
    } else throw new Error(`Unknown option: ${option}`);
  }
  options.cache = path.resolve(options.cache);
  if (prepare) {
    if (options.mode || options.output) throw new Error('Dependency preparation is separate from release build');
    process.stdout.write(JSON.stringify(await prepareDependencies(options), null, 2) + '\n');
  } else {
    if (!options.output) throw new Error('--output is required and must not exist');
    process.stdout.write(JSON.stringify(await buildPackage(options), null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`BUILD REFUSED: ${error.message}\n`); process.exitCode = 1; });
}
