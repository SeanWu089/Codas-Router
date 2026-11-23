// Console evidence only. Read exactly two bounded, sanitized report files.
// Never read a state/profile tree, raw log, child-output buffer, or credential.
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['native-package-smoke.json', 'runtime-events.sanitized.json'];
const MAX_BYTES = 128 * 1024;
const BOOLEANS = ['passed', 'newlyCreated', 'remotePaired', 'authenticated', 'workspaceOpened',
  'harmlessCommandCompleted', 'remoteAcceptance', 'cleanShutdown', 'sqliteQueryPassed',
  'koffiOwnProcessQueryPassed', 'fullPayloadVerifiedByProduct', 'actualProductBackend',
  'hostnameMatched', 'supervisorExitObserved', 'productCleanShutdown', 'backendListenerClosed',
  'supervisorNotStarted', 'forcedOwnedChild', 'allOwnedHandlesExited', 'exited',
  'physicalPcAcceptance', 'taskSchedulerAcceptance', 'stableQualification', 'paired',
  'temporaryWorkspaceRetained'];
const NUMBERS = ['files', 'bytes', 'pid', 'backendPid', 'agentPid', 'leasePid', 'exitCode',
  'failureCount', 'consecutiveFailures', 'stdoutBytes', 'stderrBytes', 'verifiedFiles',
  'totalFiles', 'ptyNativeAddonsLoaded'];
const IDENTIFIERS = ['code', 'causeCode', 'syscall', 'event', 'status', 'component',
  'exitSignal', 'exceptionType', 'node', 'abi', 'platform', 'arch', 'versionId', 'label'];
const HASHES = ['manifestSha256', 'zipSha256', 'stdoutSha256', 'stderrSha256', 'expectedSha256', 'actualSha256'];
const PHASES = new Set(['verify-assets', 'outer-zip', 'payload-extract', 'native-modules',
  'initialize-independent-state', 'real-backend-and-oauth-mcp', 'cleanup', 'finished']);
const STAGES = ['assets', 'outerZip', 'payload', 'native', 'initialization', 'localMcp'];

function safe(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return {};
  const result = {};
  for (const key of BOOLEANS) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of NUMBERS) if (value[key] === null || Number.isSafeInteger(value[key])) result[key] = value[key];
  for (const key of IDENTIFIERS) if (typeof value[key] === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(value[key])) result[key] = value[key];
  for (const key of HASHES) if (typeof value[key] === 'string' && /^[a-f0-9]{64}$/i.test(value[key])) result[key] = value[key];
  for (const key of ['failed', 'verification', 'result', 'failure', 'stop']) if (value[key]) result[key] = safe(value[key], depth + 1);
  return result;
}
function emit(value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 64 * 1024) console.log(JSON.stringify({ file: value.file, code: 'SANITIZED_SUMMARY_TOO_LARGE' }));
  else console.log(line);
}
function reportSummary(value) {
  const result = safe(value);
  if (PHASES.has(value?.phaseAtCompletion)) result.phaseAtCompletion = value.phaseAtCompletion;
  else result.phaseAtCompletion = 'UNAVAILABLE';
  result.stages = {};
  for (const name of STAGES) if (value?.stages?.[name]) result.stages[name] = safe(value.stages[name]);
  result.cleanup = safe(value?.cleanup);
  result.children = Array.isArray(value?.children) ? value.children.slice(-16).map(child => safe(child)) : [];
  result.finalSupervisor = safe(value?.finalSupervisor);
  return result;
}
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--report-dir' || !path.isAbsolute(process.argv[3]) || !process.env.RUNNER_TEMP) throw new Error();
  const requested = process.argv[3];
  if (fs.lstatSync(requested).isSymbolicLink()) throw new Error();
  const directory = fs.realpathSync(requested), temporary = fs.realpathSync(process.env.RUNNER_TEMP);
  const relative = path.relative(temporary, directory);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error();
  for (const name of FILES) {
    const filename = path.join(directory, name);
    let info;
    try { info = fs.lstatSync(filename); }
    catch { emit({ file: name, available: false, code: 'REPORT_NOT_AVAILABLE' }); continue; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) {
      emit({ file: name, available: false, code: 'REPORT_TYPE_OR_SIZE_REJECTED' }); continue;
    }
    let value;
    try {
      const bytes = fs.readFileSync(filename);
      if (bytes.length > MAX_BYTES) throw new Error();
      value = JSON.parse(bytes.toString('utf8'));
    } catch { emit({ file: name, available: false, code: 'REPORT_JSON_UNREADABLE' }); continue; }
    if (name === 'native-package-smoke.json') emit({ file: name, available: true, ...reportSummary(value) });
    else if (Array.isArray(value)) emit({ file: name, available: true, totalEvents: value.length, events: value.slice(-30).map(event => safe(event)) });
    else emit({ file: name, available: false, code: 'EVENT_REPORT_SHAPE_REJECTED' });
  }
} catch {
  emit({ available: false, code: 'SANITIZED_REPORT_DIRECTORY_UNAVAILABLE' });
  process.exitCode = 1;
}
