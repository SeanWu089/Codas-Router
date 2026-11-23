import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';

export const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function validVersionId(value) {
  return typeof value === 'string' && VERSION_ID.test(value) && !value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
export const HASH = /^[0-9a-f]{64}$/i;
export const REVISION = /^[0-9a-f]{40}$/i;
export const REQUIRED = [
  'node/node.exe', 'node/LICENSE', 'router/agent.js', 'router/package.json',
  'devspace/node_modules/@waishnav/devspace/dist/cli.js',
  'devspace/node_modules/@waishnav/devspace/package.json',
  'devspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
];

export class RuntimeFault extends Error {
  constructor(code, evidence = {}) { super(code); this.code = code; this.evidence = evidence; }
}
export function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new RuntimeFault('INVALID_ARGUMENTS');
    if (key === '--allowed-root') (result[key] ||= []).push(value);
    else if (Object.hasOwn(result, key)) throw new RuntimeFault('DUPLICATE_ARGUMENT');
    else result[key] = value;
  }
  return result;
}
export function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function noLinks(target, { missing = false } = {}) {
  let current = path.resolve(target);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new RuntimeFault('REPARSE_POINT_REJECTED'); }
    catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    const parent = path.dirname(current);
    if (current === parent) return;
    current = parent;
  }
}
export async function json(file, limit = 1024 * 1024) {
  await noLinks(file);
  if ((await fs.stat(file)).size > limit) throw new RuntimeFault('STATE_FILE_TOO_LARGE');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new RuntimeFault('INVALID_JSON'); throw error; }
}
export async function atomicJson(file, value, { exclusive = false } = {}) {
  await noLinks(path.dirname(file), { missing: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await noLinks(file, { missing: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) { await fs.link(temp, file); await fs.unlink(temp); }
    else await fs.rename(temp, file);
  } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function resolveLayout(options) {
  if (!options['--install-root'] || !path.isAbsolute(options['--install-root'])) throw new RuntimeFault('ABSOLUTE_INSTALL_ROOT_REQUIRED');
  const installRoot = path.resolve(options['--install-root']);
  await noLinks(installRoot, { missing: true });
  const stateDir = path.resolve(options['--state-dir'] || path.join(installRoot, 'state'));
  if (stateDir === installRoot || !contained(installRoot, stateDir) || contained(path.join(installRoot, 'versions'), stateDir) || contained(path.join(installRoot, 'bin'), stateDir)) throw new RuntimeFault('INVALID_STATE_DIRECTORY');
  await noLinks(stateDir, { missing: true });
  let pointer;
  if (options['--version-dir']) {
    const versionDir = path.resolve(options['--version-dir']);
    if (path.dirname(versionDir) !== path.join(installRoot, 'versions')) throw new RuntimeFault('VERSION_DIRECTORY_OUTSIDE_INSTALL');
    pointer = { schemaVersion: 1, versionId: path.basename(versionDir), manifestSha256: options['--manifest-sha256'] };
  } else pointer = await json(path.join(installRoot, 'current.json'), 4096);
  if (pointer.schemaVersion !== 1 || !validVersionId(pointer.versionId) || !HASH.test(pointer.manifestSha256 || '')) throw new RuntimeFault('INVALID_VERSION_POINTER');
  if (pointer.transportRevision !== undefined && !REVISION.test(pointer.transportRevision)) throw new RuntimeFault('INVALID_TRANSPORT_REVISION');
  const versionDir = path.join(installRoot, 'versions', pointer.versionId);
  await noLinks(versionDir);
  const payloadRoot = path.join(versionDir, 'payload');
  await noLinks(payloadRoot);
  return { installRoot, stateDir, versionDir, payloadRoot, versionId: pointer.versionId,
    manifestSha256: pointer.manifestSha256.toLowerCase(), transportRevision: pointer.transportRevision,
    manifestPath: path.join(versionDir, 'payload-manifest.json'),
    node: path.join(payloadRoot, 'node', 'node.exe'),
    runtimeDir: path.join(payloadRoot, 'runtime'),
    devspaceConfigDir: path.join(stateDir, 'devspace'),
    agentConfig: path.join(stateDir, 'agent.json'),
    logDir: stateDir === path.join(installRoot, 'state') ? path.join(installRoot, 'logs') : path.join(stateDir, 'logs') };
}
function payloadPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /[\x00-\x1f<>:"|?*]/.test(value)) throw new RuntimeFault('INVALID_PAYLOAD_PATH');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new RuntimeFault('INVALID_PAYLOAD_PATH');
  }
  return value;
}
export async function verifyPayload(layout, { criticalOnly = false, onProgress = async () => {} } = {}) {
  await noLinks(layout.manifestPath);
  if ((await fs.stat(layout.manifestPath)).size > 16 * 1024 * 1024) throw new RuntimeFault('INVALID_PAYLOAD_MANIFEST');
  const bytes = await fs.readFile(layout.manifestPath);
  if (bytes.length > 16 * 1024 * 1024) throw new RuntimeFault('INVALID_PAYLOAD_MANIFEST');
  const actualManifest = createHash('sha256').update(bytes).digest('hex');
  if (actualManifest !== layout.manifestSha256) throw new RuntimeFault('MANIFEST_HASH_MISMATCH', { expectedSha256: layout.manifestSha256, actualSha256: actualManifest });
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new RuntimeFault('INVALID_PAYLOAD_MANIFEST'); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new RuntimeFault('INVALID_PAYLOAD_MANIFEST');
  const expected = new Map();
  for (const entry of manifest.files) {
    const relative = payloadPath(entry.path), folded = relative.toLowerCase();
    if (expected.has(folded) || !HASH.test(entry.sha256 || '')) throw new RuntimeFault('INVALID_PAYLOAD_MANIFEST');
    expected.set(folded, { relative, sha256: entry.sha256.toLowerCase() });
  }
  for (const required of REQUIRED) if (!expected.has(required.toLowerCase())) throw new RuntimeFault('REQUIRED_DEPENDENCY_NOT_PINNED', { relativePath: required });
  const selected = criticalOnly ? [...expected.values()].filter(e => {
    const folded = e.relative.toLowerCase();
    return REQUIRED.some(required => required.toLowerCase() === folded) || folded.startsWith('runtime/') || folded.startsWith('router/');
  }) : [...expected.values()];
  const observed = new Map();
  if (!criticalOnly) {
    await noLinks(layout.payloadRoot);
    const pending = [layout.payloadRoot];
    while (pending.length) {
      const directory = pending.pop();
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new RuntimeFault('REPARSE_POINT_REJECTED');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new RuntimeFault('REPARSE_POINT_REJECTED');
        if (entry.isDirectory()) pending.push(full);
        else {
          const folded = path.relative(layout.payloadRoot, full).split(path.sep).join('/').toLowerCase();
          if (!entry.isFile() || !expected.has(folded) || observed.has(folded)) throw new RuntimeFault('UNMANIFESTED_PAYLOAD_FILE');
          observed.set(folded, full);
        }
      }
    }
  }
  let next = 0, completed = 0, failure;
  let progress = Promise.resolve();
  await onProgress({ verifiedFiles: 0, totalFiles: selected.length });
  // Bounded streams avoid tens of thousands of repeated ancestor stats while
  // retaining a complete non-reparse tree walk and a hash for every file.
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, async () => {
    while (!failure) {
      const entry = selected[next++];
      if (!entry) return;
      const { relative, sha256 } = entry;
      const file = criticalOnly ? path.join(layout.payloadRoot, ...relative.split('/')) : observed.get(relative.toLowerCase());
      try {
        if (!file) throw new RuntimeFault('PAYLOAD_FILE_MISSING', { relativePath: relative, expectedSha256: sha256, actualSha256: null });
        if (criticalOnly) await noLinks(file);
        if (!(await fs.lstat(file)).isFile()) throw new RuntimeFault('PAYLOAD_NOT_FILE', { relativePath: relative });
        const actual = await digest(file);
        if (actual !== sha256) throw new RuntimeFault('PAYLOAD_HASH_MISMATCH', { relativePath: relative, expectedSha256: sha256, actualSha256: actual });
        completed++;
        if (completed % 1000 === 0 || completed === selected.length) {
          const snapshot = { verifiedFiles: completed, totalFiles: selected.length };
          progress = progress.then(() => onProgress(snapshot));
          await progress;
        }
      } catch (error) {
        failure ||= error.code === 'ENOENT' ? new RuntimeFault('PAYLOAD_FILE_MISSING', { relativePath: relative, expectedSha256: sha256, actualSha256: null }) : error;
      }
    }
  }));
  if (failure) throw failure;
  return { files: expected.size, manifestSha256: actualManifest };
}
export async function installation(layout) {
  const value = await json(path.join(layout.stateDir, 'installation.json'), 65536);
  if (value.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(value.installationId || '') || !Number.isInteger(value.backendPort) || value.backendPort < 1024 || value.backendPort > 65535 || !Array.isArray(value.allowedRoots) || !value.allowedRoots.length || value.allowedRoots.some(p => !path.isAbsolute(p))) throw new RuntimeFault('INVALID_INSTALLATION_STATE');
  return value;
}
export function childEnvironment(layout) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.DEVSPACE_OAUTH_OWNER_TOKEN;
  environment.DEVSPACE_CONFIG_DIR = layout.devspaceConfigDir;
  environment.CODAS_WINDOWS_STATE_DIR = layout.stateDir;
  environment.CODAS_WINDOWS_PAYLOAD_ROOT = layout.payloadRoot;
  environment.CODASSOL_AGENT_CONFIG = layout.agentConfig;
  environment.CODASSOL_AGENT_TRANSPORT = 'sse';
  return environment;
}
export function delay(ms, signal) {
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    if (signal?.aborted) return finish();
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
export const backoff = failures => Math.min(30_000, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
export function settlesWithin(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function safeFailure(error) {
  if (error instanceof RuntimeFault) return { code: error.code, ...error.evidence };
  const codes = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EINVAL', 'EBADF', 'EAGAIN', 'ETXTBSY']);
  const syscalls = new Set(['open', 'read', 'write', 'rename', 'unlink', 'lstat', 'stat', 'scandir', 'mkdir', 'rmdir', 'fsync', 'close', 'link']);
  return { code: 'RUNTIME_OPERATION_FAILED',
    ...(codes.has(error?.code) ? { causeCode: error.code } : {}),
    ...(syscalls.has(error?.syscall) ? { syscall: error.syscall } : {}) };
}
