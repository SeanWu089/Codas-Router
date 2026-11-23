// Real offline package compatibility check for an isolated GitHub Windows runner.
// Never a physical-PC, Task Scheduler, remote-plugin or stable qualification.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'Codas-Windows-0.2.0-rc.4';
const VERSION = 'windows-0.2.0-rc.4-c1497ca';
export const BINDING_FIELDS = ['schemaVersion', 'repository', 'repositoryId', 'sourceCommit', 'candidateRunId', 'candidateRunAttempt', 'candidateArtifactId', 'artifactName', 'artifactSize', 'artifactDigest', 'zipSize', 'zipSha256', 'manifestSha256'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class SmokeFault extends Error { constructor(code) { super(code); this.code = code; } }
const requireTrue = (value, code) => { if (!value) throw new SmokeFault(code); };
export function validateBinding(binding, receipt) {
  requireTrue(binding?.schemaVersion === 1 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository || '') && /^[a-f0-9]{40}$/.test(binding.sourceCommit || ''), 'INVALID_CANDIDATE_BINDING');
  for (const key of ['repositoryId', 'candidateRunId', 'candidateRunAttempt', 'candidateArtifactId', 'artifactSize', 'zipSize']) requireTrue(Number.isSafeInteger(binding[key]) && binding[key] > 0, 'INVALID_CANDIDATE_BINDING');
  requireTrue(binding.artifactName === `${PACKAGE_NAME}-${binding.sourceCommit}-${binding.candidateRunAttempt}` && /^sha256:[a-f0-9]{64}$/.test(binding.artifactDigest || '') && /^[a-f0-9]{64}$/.test(binding.zipSha256 || '') && /^[a-f0-9]{64}$/.test(binding.manifestSha256 || ''), 'INVALID_CANDIDATE_BINDING');
  requireTrue(receipt?.verified === true && BINDING_FIELDS.every(key => receipt[key] === binding[key]), 'CANDIDATE_BINDING_NOT_VERIFIED');
  return binding;
}
export function safeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  const booleans = ['passed', 'newlyCreated', 'remotePaired', 'authenticated', 'workspaceOpened', 'harmlessCommandCompleted', 'remoteAcceptance', 'cleanShutdown', 'sqliteQueryPassed', 'koffiOwnProcessQueryPassed'];
  const numbers = ['files', 'bytes', 'pid', 'backendPid', 'agentPid', 'leasePid', 'exitCode', 'failureCount', 'consecutiveFailures', 'stdoutBytes', 'stderrBytes', 'verifiedFiles', 'totalFiles', 'ptyNativeAddonsLoaded'];
  const identifiers = ['code', 'causeCode', 'syscall', 'event', 'status', 'component', 'exitSignal', 'exceptionType', 'node', 'abi', 'platform', 'arch', 'versionId'];
  for (const key of booleans) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of numbers) if (value[key] === null || Number.isSafeInteger(value[key])) result[key] = value[key];
  for (const key of identifiers) if (typeof value[key] === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(value[key])) result[key] = value[key];
  for (const key of ['manifestSha256', 'stdoutSha256', 'stderrSha256', 'expectedSha256', 'actualSha256']) if (/^[a-f0-9]{64}$/i.test(value[key] || '')) result[key] = value[key];
  if (value.failed) result.failed = safeEvidence(value.failed);
  if (value.verification) result.verification = safeEvidence(value.verification);
  return result;
}
function readJson(filename, maximum = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  requireTrue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'INVALID_LOCAL_METADATA');
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}
function safeRelative(name) {
  requireTrue(typeof name === 'string' && name && !/[\\\x00-\x1f<>:"|?*]/.test(name) && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'UNSAFE_PACKAGE_MEMBER');
  return name;
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function listFiles(root) {
  const files = [], pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      requireTrue(!entry.isSymbolicLink(), 'REDIRECTED_PACKAGE_MEMBER');
      if (entry.isDirectory()) pending.push(full);
      else { requireTrue(entry.isFile() && fs.lstatSync(full).nlink === 1, 'NON_REGULAR_PACKAGE_MEMBER'); files.push(path.relative(root, full).split(path.sep).join('/')); }
    }
  }
  return files.sort();
}
function lastJson(text) {
  for (const line of text.split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line.replace(/^\uFEFF/, '')); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Only structured JSON is eligible for retained output. */ }
  }
  return null;
}
function childEnvironment(temporary, nodeDirectory) {
  const environment = {};
  // Preserve the runner's network/security controls; never weaken policy or CA
  // settings. Do not copy GitHub/provider tokens or unrelated service secrets.
  const inherited = /^(SystemRoot|windir|SystemDrive|ComSpec|PATH|PATHEXT|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PSExecutionPolicyPreference|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE)$/i;
  for (const [key, value] of Object.entries(process.env)) if (inherited.test(key)) environment[key] = value;
  const profile = path.join(temporary, 'profile');
  for (const directory of [profile, path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local'), path.join(temporary, 'child-temp')]) fs.mkdirSync(directory, { recursive: true });
  environment.USERPROFILE = profile;
  environment.APPDATA = path.join(profile, 'AppData/Roaming');
  environment.LOCALAPPDATA = path.join(profile, 'AppData/Local');
  environment.TEMP = environment.TMP = path.join(temporary, 'child-temp');
  const inheritedPathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path');
  const inheritedPath = inheritedPathKey ? environment[inheritedPathKey] : '';
  if (inheritedPathKey) delete environment[inheritedPathKey];
  environment.PATH = nodeDirectory + path.delimiter + inheritedPath;
  return environment;
}

export async function runSmoke(options) {
  requireTrue(process.platform === 'win32' && process.arch === 'x64' && process.env.GITHUB_ACTIONS === 'true', 'ISOLATED_GITHUB_WINDOWS_RUNNER_REQUIRED');
  requireTrue(process.version === 'v22.23.3', 'NODE_22_23_3_CONTROLLER_REQUIRED');
  // Refuse injected module/preload settings instead of clearing controls or
  // letting a missing packaged dependency resolve from an outside module path.
  requireTrue(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'RUNNER_NODE_INJECTION_PRESENT');
  const binding = validateBinding(readJson(options.bindingFile), readJson(options.bindingReceipt));
  requireTrue(binding.repository === process.env.GITHUB_REPOSITORY, 'CURRENT_REPOSITORY_MISMATCH');
  const sourceRoot = fs.realpathSync.native(process.cwd());
  const artifactDirectory = fs.realpathSync.native(path.resolve(options.artifactDir));
  fs.mkdirSync(options.reportDir, { recursive: true });
  const reportDirectory = fs.realpathSync.native(path.resolve(options.reportDir));
  requireTrue(fs.readdirSync(reportDirectory).length === 0, 'REPORT_DIRECTORY_NOT_EMPTY');
  const temporaryBase = fs.realpathSync.native(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryBase, 'codas-package-ci-'));
  const report = { schemaVersion: 1, kind: 'github-windows-complete-package-smoke', passed: false, ...Object.fromEntries(BINDING_FIELDS.map(key => [key, binding[key]])), physicalPcAcceptance: false, taskSchedulerAcceptance: false, remoteAcceptance: false, stableQualification: false, paired: false, phase: 'verify-assets', children: [], stages: {}, cleanup: {}, temporaryWorkspaceRetained: false };
  const owned = new Set();
  const abort = new AbortController();
  const totalTimer = setTimeout(() => abort.abort(), 20 * 60 * 1000);
  const stopSignal = () => abort.abort();
  process.once('SIGINT', stopSignal); process.once('SIGTERM', stopSignal);
  let supervisor, installRoot, stateDirectory, versionDirectory, node, runtime, baseArgs, environment, port, failure;
  const bounded = async (promise, ms, code, cleanup = false) => {
    let timer, abortHandler;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFault(code)), ms);
        if (!cleanup) { abortHandler = () => reject(new SmokeFault('SMOKE_TOTAL_TIMEOUT_OR_CANCELLED')); abort.signal.addEventListener('abort', abortHandler, { once: true }); if (abort.signal.aborted) abortHandler(); }
      })]);
    } finally { clearTimeout(timer); if (abortHandler) abort.signal.removeEventListener('abort', abortHandler); }
  };
  const launch = (label, executable, argv, { ipc = false } = {}) => {
    const child = spawn(executable, argv, { cwd: temporary, env: environment, shell: false, windowsHide: true, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    const record = { label, child, exited: false, streams: {} };
    owned.add(record);
    for (const name of ['stdout', 'stderr']) {
      const stream = record.streams[name] = { bytes: 0, hash: crypto.createHash('sha256'), chunks: [], retained: 0 };
      child[name]?.on('data', chunk => { stream.bytes += chunk.length; stream.hash.update(chunk); if (stream.retained < 128 * 1024) { const part = chunk.subarray(0, 128 * 1024 - stream.retained); stream.chunks.push(part); stream.retained += part.length; } });
    }
    record.done = new Promise(resolve => {
      child.once('error', error => { record.spawnCode = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'CHILD_SPAWN_FAILED'; if (!child.pid) { record.exited = true; resolve(); } });
      child.once('exit', (code, signal) => { record.exited = true; record.exitCode = code; record.exitSignal = signal; });
      child.once('close', () => { record.closed = true; resolve(); });
    });
    return record;
  };
  const childResult = record => {
    const stdout = Buffer.concat(record.streams.stdout.chunks).toString('utf8');
    const stderr = Buffer.concat(record.streams.stderr.chunks).toString('utf8');
    const result = lastJson(stdout) || lastJson(stderr);
    report.children.push({ label: record.label, exited: record.exited, exitCode: record.exitCode ?? null, exitSignal: record.exitSignal ?? null, ...(record.spawnCode ? { code: record.spawnCode } : {}), stdoutBytes: record.streams.stdout.bytes, stderrBytes: record.streams.stderr.bytes, stdoutSha256: record.streams.stdout.hash.copy().digest('hex'), stderrSha256: record.streams.stderr.hash.copy().digest('hex'), result: safeEvidence(result) });
    return result;
  };
  const execute = async (label, executable, argv, timeoutMs, { cleanup = false } = {}) => {
    const record = launch(label, executable, argv);
    try { await bounded(record.done, timeoutMs, 'OWNED_CHILD_TIMEOUT', cleanup); }
    catch (error) { if (!record.exited && record.child.pid) record.child.kill('SIGKILL'); await bounded(record.done, 5000, 'OWNED_CHILD_EXIT_NOT_OBSERVED', true).catch(() => {}); childResult(record); throw error; }
    const result = childResult(record);
    requireTrue(record.exitCode === 0 && !record.spawnCode && result?.passed === true, 'OWNED_STEP_FAILED_' + label.replace(/[^A-Za-z0-9]/g, '_').toUpperCase());
    return result;
  };
  const receipt = () => {
    if (!stateDirectory || !fs.existsSync(path.join(stateDirectory, 'supervisor.json'))) return null;
    const value = readJson(path.join(stateDirectory, 'supervisor.json'), 32768);
    requireTrue(value.schemaVersion === 1 && value.pid === supervisor?.child.pid && value.versionId === VERSION && /^[0-9a-f-]{36}$/i.test(value.instanceId || ''), 'OWNED_SUPERVISOR_RECEIPT_MISMATCH');
    return value;
  };
  const listenerClosed = async () => {
    if (!port) return true;
    return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); const finish = value => { socket.destroy(); resolve(value); }; socket.setTimeout(1500, () => finish(false)); socket.once('connect', () => finish(false)); socket.once('error', error => finish(error.code === 'ECONNREFUSED')); });
  };
  try {
    const { verifyAssets } = await import(pathToFileURL(path.join(sourceRoot, '.github/scripts/windows-draft-release.mjs')).href);
    const assets = await bounded(verifyAssets({ directory: artifactDirectory, repository: binding.repository, sha: binding.sourceCommit }), 120000, 'ASSET_VERIFICATION_TIMEOUT');
    const zip = assets.find(asset => asset.name === `${PACKAGE_NAME}.zip`);
    requireTrue(zip?.sha256 === binding.zipSha256 && zip.size === binding.zipSize, 'BOUND_ZIP_MISMATCH');
    const releaseBytes = fs.readFileSync(path.join(artifactDirectory, 'release.json'));
    const manifestBytes = fs.readFileSync(path.join(artifactDirectory, 'payload-manifest.json'));
    const release = JSON.parse(releaseBytes), manifest = JSON.parse(manifestBytes);
    requireTrue(release.manifestSha256 === binding.manifestSha256 && sha256(manifestBytes) === binding.manifestSha256 && release.versionId === VERSION, 'BOUND_MANIFEST_MISMATCH');
    report.stages.assets = { passed: true, files: assets.length, zipSha256: zip.sha256, manifestSha256: release.manifestSha256 };
    const outerParent = path.join(temporary, 'outer');
    environment = childEnvironment(temporary, path.dirname(process.execPath));
    const powershell = path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    requireTrue(fs.statSync(powershell).isFile(), 'WINDOWS_POWERSHELL_MISSING');
    report.phase = 'outer-zip';
    report.stages.outerZip = safeEvidence(await execute('outer-zip', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(scriptDirectory, 'Expand-CandidateOuter.ps1'), '-ZipPath', zip.filename, '-TargetDirectory', outerParent], 120000));
    const packageRoot = fs.realpathSync.native(path.join(outerParent, PACKAGE_NAME));
    requireTrue(fs.readFileSync(path.join(packageRoot, 'release.json')).equals(releaseBytes) && fs.readFileSync(path.join(packageRoot, 'payload-manifest.json')).equals(manifestBytes), 'ZIP_METADATA_MISMATCH');
    requireTrue(Array.isArray(release.installerFiles) && release.installerFiles.length > 0, 'INSTALLER_PINS_MISSING');
    const pinMap = new Map();
    for (const pin of release.installerFiles) {
      const name = safeRelative(pin.path);
      requireTrue(!pinMap.has(name.toLowerCase()) && /^[a-f0-9]{64}$/.test(pin.sha256 || '') && (/^installer\/[^/]+\.(?:ps1|mjs)$/.test(name) || ['INSTALL.cmd', 'bootstrap/node.exe', 'bootstrap/LICENSE'].includes(name)), 'INVALID_INSTALLER_PIN');
      const file = path.join(packageRoot, name), stat = fs.lstatSync(file);
      requireTrue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await hashFile(file) === pin.sha256, 'INSTALLER_PIN_MISMATCH');
      pinMap.set(name.toLowerCase(), pin.sha256);
    }
    for (const required of ['bootstrap/node.exe', 'bootstrap/LICENSE', 'installer/Unpack-Payload.mjs', 'installer/Payload-Tool.mjs']) requireTrue(pinMap.has(required.toLowerCase()), 'BOOTSTRAP_PIN_MISSING');
    const expectedOuter = [...release.installerFiles.map(item => item.path), 'LICENSE', 'README-WINDOWS.md', 'THIRD-PARTY-LICENSES.json', 'THIRD-PARTY-NOTICES.md', 'payload-manifest.json', 'payload-index.json', 'payload.codas', 'qualification-pending.json', 'release.json'].sort();
    requireTrue(JSON.stringify(listFiles(packageRoot)) === JSON.stringify(expectedOuter), 'OUTER_FILE_INVENTORY_MISMATCH');
    installRoot = path.join(temporary, 'installation');
    stateDirectory = path.join(installRoot, 'state');
    versionDirectory = path.join(installRoot, 'versions', VERSION);
    fs.mkdirSync(versionDirectory, { recursive: true });
    fs.writeFileSync(path.join(versionDirectory, 'release.json'), releaseBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(versionDirectory, 'payload-manifest.json'), manifestBytes, { flag: 'wx' });
    report.phase = 'payload-extract';
    const extracted = await execute('payload-extract', path.join(packageRoot, 'bootstrap/node.exe'), [path.join(packageRoot, 'installer/Unpack-Payload.mjs'), '--package-root', packageRoot, '--target', path.join(versionDirectory, 'payload'), '--install-root', installRoot], 300000);
    requireTrue(extracted.files === manifest.files.length, 'EXTRACTED_INVENTORY_MISMATCH');
    report.stages.payload = { passed: true, files: extracted.files, manifestSha256: binding.manifestSha256 };
    const payload = path.join(versionDirectory, 'payload');
    node = path.join(payload, 'node/node.exe'); runtime = path.join(payload, 'runtime');
    environment = childEnvironment(temporary, path.dirname(node));
    report.phase = 'native-modules';
    report.stages.native = safeEvidence(await execute('native-modules', node, [path.join(scriptDirectory, 'native-module-probe.cjs'), payload], 60000));
    const workspace = path.join(temporary, 'authorized-workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'smoke-marker.txt'), 'Isolated CI package probe workspace.\n', { flag: 'wx' });
    port = await bounded(new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { const selected = server.address().port; server.close(error => error ? reject(error) : resolve(selected)); }); }), 5000, 'LOOPBACK_PORT_ALLOCATION_TIMEOUT');
    baseArgs = ['--install-root', installRoot, '--version-dir', versionDirectory, '--manifest-sha256', binding.manifestSha256, '--state-dir', stateDirectory];
    report.phase = 'initialize-independent-state';
    const initialized = await execute('initialize-state', node, [path.join(runtime, 'init-state.mjs'), ...baseArgs, '--allowed-root', workspace, '--backend-port', String(port)], 360000);
    requireTrue(initialized.newlyCreated === true && initialized.remotePaired === false && !fs.existsSync(path.join(stateDirectory, 'agent.json')), 'STATE_NOT_FRESH_AND_UNPAIRED');
    report.stages.initialization = { passed: true, newlyCreated: true, remotePaired: false, fullPayloadVerifiedByProduct: true };
    report.phase = 'real-backend-and-oauth-mcp';
    supervisor = launch('supervisor', node, [path.join(runtime, 'supervisor.mjs'), ...baseArgs], { ipc: true });
    const probed = await execute('oauth-mcp-hostname', node, [path.join(runtime, 'probe.mjs'), ...baseArgs, '--workspace', workspace, '--timeout-ms', '300000'], 310000);
    requireTrue(probed.authenticated === true && probed.workspaceOpened === true && probed.harmlessCommandCompleted === true && probed.remoteAcceptance === false && probed.manifestSha256 === binding.manifestSha256 && typeof probed.hostname === 'string' && probed.hostname.toLowerCase() === os.hostname().toLowerCase(), 'REAL_LOCAL_MCP_PROBE_FAILED');
    const ready = receipt();
    requireTrue(ready?.status === 'local-ready' && Number.isSafeInteger(ready.backendPid) && ready.backendPid > 0 && ready.agentPid === null && !fs.existsSync(path.join(stateDirectory, 'agent.json')), 'UNPAIRED_LOCAL_BACKEND_NOT_READY');
    report.stages.localMcp = { passed: true, actualProductBackend: true, authenticated: true, workspaceOpened: true, hostnameMatched: true, harmlessCommandCompleted: true, remoteAcceptance: false };
  } catch (error) {
    failure = error;
    report.failure = { code: /^[A-Z][A-Z0-9_]{0,120}$/.test(error?.code || '') ? error.code : 'SMOKE_OPERATION_FAILED', ...(safeEvidence(error)) };
  } finally {
    report.phaseAtCompletion = report.phase;
    report.phase = 'cleanup';
    try {
      if (supervisor) {
        const current = receipt();
        if (!supervisor.exited && stateDirectory && fs.existsSync(path.join(stateDirectory, 'enabled.json'))) {
          const stopArgs = [path.join(runtime, 'control.mjs'), ...baseArgs, '--action', 'stop', '--timeout-ms', '45000'];
          if (current) stopArgs.push('--instance-id', current.instanceId);
          report.cleanup.stop = safeEvidence(await execute('product-stop', node, stopArgs, 50000, { cleanup: true }));
        }
        await bounded(supervisor.done, 20000, 'SUPERVISOR_EXIT_NOT_OBSERVED', true);
        const stopped = receipt();
        report.cleanup.supervisorExitObserved = supervisor.exited;
        report.cleanup.productCleanShutdown = stopped?.status === 'stopped' && stopped.cleanShutdown === true;
        report.cleanup.backendListenerClosed = await listenerClosed();
        requireTrue(report.cleanup.supervisorExitObserved && report.cleanup.productCleanShutdown && report.cleanup.backendListenerClosed, 'PRODUCT_SHUTDOWN_INCOMPLETE');
        requireTrue(supervisor.exitCode === 0 && !stopped?.failed, 'PRODUCT_SUPERVISOR_FAILED');
      } else report.cleanup.supervisorNotStarted = true;
    } catch (error) {
      failure ||= error;
      report.cleanup.failure = safeEvidence(error);
      // Disconnect asks the unmodified supervisor to abort and stop its own
      // children. Never send signals to PIDs copied from a receipt or CIM list.
      if (supervisor && !supervisor.exited && supervisor.child.connected) supervisor.child.disconnect();
      if (supervisor && !supervisor.exited) await bounded(supervisor.done, 15000, 'SUPERVISOR_ABORT_TIMEOUT', true).catch(() => {});
    }
    for (const record of owned) {
      if (!record.exited && record.child.pid) {
        report.cleanup.forcedOwnedChild = true;
        failure ||= new SmokeFault('OWNED_CHILD_REQUIRED_FORCE_STOP');
        record.child.kill('SIGKILL');
        await bounded(record.done, 5000, 'OWNED_CHILD_EXIT_NOT_OBSERVED', true).catch(() => {});
      }
    }
    if (supervisor) childResult(supervisor);
    report.cleanup.allOwnedHandlesExited = [...owned].every(record => record.exited);
    if (!report.cleanup.allOwnedHandlesExited) failure ||= new SmokeFault('OWNED_CHILD_EXIT_NOT_OBSERVED');
    const diagnostics = [];
    if (installRoot) {
      for (const filename of ['runtime.jsonl.previous', 'runtime.jsonl']) {
        const file = path.join(installRoot, 'logs', filename);
        if (!fs.existsSync(file)) continue;
        try {
          if (fs.statSync(file).size > 1024 * 1024) throw new SmokeFault('RUNTIME_LOG_OVERSIZED');
          for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) diagnostics.push(safeEvidence(JSON.parse(line)));
        } catch { diagnostics.push({ code: 'RUNTIME_LOG_UNREADABLE' }); }
      }
      try { const finalReceipt = receipt(); if (finalReceipt) report.finalSupervisor = safeEvidence(finalReceipt); } catch { report.finalSupervisor = { code: 'SUPERVISOR_RECEIPT_UNREADABLE' }; }
    }
    fs.writeFileSync(path.join(reportDirectory, 'runtime-events.sanitized.json'), JSON.stringify(diagnostics, null, 2) + '\n');
    report.passed = !failure && report.stages.localMcp?.passed === true;
    report.phase = 'finished';
    report.temporaryWorkspaceRetained = !report.passed;
    // Keep failed private state on the ephemeral runner only. Do not upload
    // credentials, state/config trees, raw child logs, or a diagnostic archive.
    if (report.passed) {
      try { await bounded(fsp.rm(temporary, { recursive: true, force: true, maxRetries: 3 }), 30000, 'PRIVATE_WORKSPACE_CLEANUP_TIMEOUT', true); }
      catch { report.passed = false; report.temporaryWorkspaceRetained = true; report.cleanup.failure = { code: 'PRIVATE_WORKSPACE_CLEANUP_FAILED' }; }
    }
    clearTimeout(totalTimer);
    process.removeListener('SIGINT', stopSignal); process.removeListener('SIGTERM', stopSignal);
    fs.writeFileSync(path.join(reportDirectory, 'native-package-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--artifact-dir': 'artifactDir', '--binding-file': 'bindingFile', '--binding-receipt': 'bindingReceipt', '--report-dir': 'reportDir' }[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) throw new SmokeFault('INVALID_SMOKE_ARGUMENTS');
    options[key] = path.resolve(argv[i + 1]);
  }
  if (Object.keys(options).length !== 4) throw new SmokeFault('MISSING_SMOKE_ARGUMENTS');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runSmoke(parseArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ passed: report.passed, kind: report.kind, candidateRunId: report.candidateRunId, candidateArtifactId: report.candidateArtifactId, physicalPcAcceptance: false, taskSchedulerAcceptance: false, remoteAcceptance: false, stableQualification: false }) + '\n', () => process.exit(report.passed ? 0 : 1));
  } catch (error) {
    process.stderr.write(JSON.stringify({ passed: false, code: /^[A-Z][A-Z0-9_]{0,120}$/.test(error?.code || '') ? error.code : 'SMOKE_PREFLIGHT_FAILED' }) + '\n', () => process.exit(1));
  }
}
