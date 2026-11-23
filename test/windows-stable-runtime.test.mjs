import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { args, atomicJson, backoff, childEnvironment, digest, json, resolveLayout, safeFailure, verifyPayload, REQUIRED } from '../scripts/windows/stable/runtime/common.mjs';
import { initializeState } from '../scripts/windows/stable/runtime/init-state.mjs';
import { control } from '../scripts/windows/stable/runtime/control.mjs';
import { supervise } from '../scripts/windows/stable/runtime/supervisor.mjs';
import { createLogger } from '../scripts/windows/stable/runtime/log.mjs';
import { probe } from '../scripts/windows/stable/runtime/probe.mjs';

const runtime = fileURLToPath(new URL('../scripts/windows/stable/runtime/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(15); }
  throw new Error('Fixture observation timed out');
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, { backend = {}, pair = false, token = 'valid' } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codas-runtime-'));
  const cleanupTasks = [];
  t.after(async () => {
    // Windows will not remove the held OS lock or running Node executable.
    // Stop fixture-owned processes before deleting their directory on all hosts.
    for (const cleanup of cleanupTasks.toReversed()) await cleanup();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  const root = path.join(temp, 'install'), workspace = path.join(temp, 'workspace');
  const version = path.join(root, 'versions', 'candidate-test'), payload = path.join(version, 'payload');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(payload, 'node'), { recursive: true });
  try { await fs.link(process.execPath, path.join(payload, 'node', 'node.exe')); }
  catch { await fs.copyFile(process.execPath, path.join(payload, 'node', 'node.exe')); }
  await fs.writeFile(path.join(payload, 'node', 'LICENSE'), 'fixture-license');
  await fs.cp(runtime, path.join(payload, 'runtime'), { recursive: true });
  const dev = path.join(payload, 'devspace', 'node_modules', '@waishnav', 'devspace');
  await fs.mkdir(path.join(dev, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dev, 'package.json'), JSON.stringify({ name: '@waishnav/devspace', version: '1.1.0-beta.4', type: 'module' }));
  await fs.writeFile(path.join(dev, 'dist', 'process-sessions.js'), 'export class ProcessSessionManager { createSession(){ return {id:this.nextSessionId++}; } }');
  await fs.writeFile(path.join(dev, 'dist', 'cli.js'), `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import os from 'node:os';
const state=process.env.CODAS_WINDOWS_STATE_DIR;
const config=JSON.parse(fs.readFileSync(path.join(process.env.DEVSPACE_CONFIG_DIR,'config.jsonc'),'utf8'));
const fixture=JSON.parse(fs.readFileSync(path.join(state,'fixture.json'),'utf8'));
const countFile=path.join(state,'backend-starts.txt');
const count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8'):0)+1;fs.writeFileSync(countFile,String(count));
const started=Date.now();
const server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');
 let body='';for await(const part of req)body+=part;
 if(req.url==='/healthz'){if(Date.now()-started<(fixture.healthDelayMs||0)){res.statusCode=503;res.end('{}');}else res.end(JSON.stringify({ok:true,name:'devspace'}));return;}
 if(req.url==='/.well-known/oauth-protected-resource/mcp'){res.end(JSON.stringify({resource:config.server.publicBaseUrl+'/mcp'}));return;}
 if(req.url==='/register'){res.end(JSON.stringify({client_id:'fixture-client'}));return;}
 if(req.url==='/authorize'){const form=new URLSearchParams(body);const auth=JSON.parse(fs.readFileSync(path.join(process.env.DEVSPACE_CONFIG_DIR,'auth.json'),'utf8'));if(form.get('owner_token')!==auth.ownerToken){res.statusCode=403;res.end('{}');return;}const target=new URL(form.get('redirect_uri'));target.searchParams.set('state',form.get('state'));target.searchParams.set('code','fixture-code');res.statusCode=303;res.setHeader('location',target.href);res.end();return;}
 if(req.url==='/token'){res.end(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}));return;}
 if(req.url==='/mcp'){if(req.headers.authorization!=='Bearer fixture-access'){res.statusCode=401;res.end('{}');return;}const value=JSON.parse(body);const tool=value.params?.name;const result=tool==='open_workspace'?{structuredContent:{workspace_id:'ws_fixture'}}:{structuredContent:{exit_code:0,running:false,result:os.hostname()+'\\nProcess exited with code 0.'}};res.end(JSON.stringify({jsonrpc:'2.0',id:value.id,result}));return;}
 res.statusCode=404;res.end('{}');});
server.listen(config.server.port,'127.0.0.1');
if(fixture.ignoreStop){process.on('SIGTERM',()=>{});}else{process.on('SIGTERM',()=>server.close(()=>process.exit(0)));}
if(count<=(fixture.crashes||0))setTimeout(()=>process.exit(7),fixture.crashAfterMs||100);
`);
  const native = path.join(payload, 'devspace', 'node_modules', 'better-sqlite3', 'build', 'Release');
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(path.join(native, 'better_sqlite3.node'), 'fixture-only-never-loaded');
  await fs.mkdir(path.join(payload, 'router'), { recursive: true });
  await fs.writeFile(path.join(payload, 'router', 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(payload, 'router', 'agent-config.js'), `import {readFile} from 'node:fs/promises';export class AgentConfigStore {constructor(file){this.file=file;}async load(){return JSON.parse(await readFile(this.file,'utf8'));}}`);
  await fs.copyFile(fileURLToPath(new URL('../src/devspace-local-auth.js', import.meta.url)), path.join(payload, 'router', 'devspace-local-auth.js'));
  await fs.writeFile(path.join(payload, 'router', 'agent.js'), `import fs from 'node:fs';import path from 'node:path';export async function runAgent({configStore,signal}){const config=await configStore.load();const file=path.join(process.env.CODAS_WINDOWS_STATE_DIR,'agent-starts.txt');fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1));if(config.agentToken==='reject'){throw Object.assign(new Error('private-token-DO-NOT-LOG'),{status:401});}await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});}`);
  const files = [];
  async function walk(dir) { for (const item of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) await walk(full); else files.push({ path: path.relative(payload, full).split(path.sep).join('/'), sha256: await digest(full) }); } }
  await walk(payload);
  const manifest = { schemaVersion: 1, files };
  const manifestPath = path.join(version, 'payload-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const pin = await digest(manifestPath);
  await atomicJson(path.join(root, 'current.json'), { schemaVersion: 1, versionId: 'candidate-test', manifestSha256: pin, transportRevision: 'a'.repeat(40) });
  const port = await freePort();
  const options = { '--install-root': root };
  await initializeState({ ...options, '--allowed-root': [workspace], '--backend-port': String(port) });
  const layout = await resolveLayout(options);
  await atomicJson(path.join(layout.stateDir, 'fixture.json'), backend);
  if (pair) {
    const installed = await json(path.join(layout.stateDir, 'installation.json'));
    await atomicJson(layout.agentConfig, { version: 1, routerUrl: 'https://fixture.example', agentToken: token, device: { id: installed.deviceId, installationId: installed.installationId, roots: installed.allowedRoots }, devspace: { baseUrl: `http://127.0.0.1:${port}`, ownerTokenPath: path.join(layout.devspaceConfigDir, 'auth.json'), oauth: {} } });
  }
  return { root, workspace, version, payload, manifestPath, manifest, pin, port, options, layout, cleanupTasks,
    async count(name) { return Number(await fs.readFile(path.join(layout.stateDir, `${name}-starts.txt`), 'utf8').catch(e => { if (e.code === 'ENOENT') return '0'; throw e; })); },
    async receipt() { return json(path.join(layout.stateDir, 'supervisor.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; }); }
  };
}
function run(t, f, overrides = {}) {
  const controller = new AbortController();
  const promise = supervise(f.options, { tickMs: 10, healthIntervalMs: 10, stopGraceMs: 10000, backoffFn: () => 10, signal: controller.signal, ...overrides });
  f.cleanupTasks.push(async () => { controller.abort(); await promise.catch(() => {}); });
  return { controller, promise };
}

test('arguments require unambiguous key/value pairs; backoff remains capped without attempt limit', () => {
  assert.deepEqual(args(['--allowed-root', 'a', '--allowed-root', 'b']), { '--allowed-root': ['a', 'b'] });
  assert.throws(() => args(['--install-root', 'x', '--install-root', 'y']));
  assert.equal(backoff(4), 8000); assert.equal(backoff(5000), 30000);
});
test('filesystem diagnostics preserve only recognized error codes and operations, without raw messages or paths', () => {
  const failure = Object.assign(new Error('PRIVATE-CREDENTIAL'), { code: 'EPERM', syscall: 'rename', path: '/private/PRIVATE-CREDENTIAL', dest: '/private/config' });
  assert.deepEqual(safeFailure(failure), { code: 'RUNTIME_OPERATION_FAILED', causeCode: 'EPERM', syscall: 'rename' });
  assert.deepEqual(safeFailure({ code: 'E_PRIVATE_CREDENTIAL', syscall: 'private_credential', message: 'secret' }), { code: 'RUNTIME_OPERATION_FAILED' });
});
test('fresh initialization isolates state and repeat initialization never changes owner credential or identity', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.layout.devspaceConfigDir, 'auth.json'));
  const first = await json(path.join(f.layout.stateDir, 'installation.json'));
  const result = await initializeState({ ...f.options, '--allowed-root': [f.workspace], '--backend-port': String(f.port) });
  assert.equal(result.newlyCreated, false);
  assert.equal(result.installationId, first.installationId);
  assert.deepEqual(await fs.readFile(path.join(f.layout.devspaceConfigDir, 'auth.json')), before);
  const config = await json(path.join(f.layout.devspaceConfigDir, 'config.jsonc'));
  assert.equal(config.storage.stateDir, path.join(f.layout.stateDir, 'devspace-storage'));
  const env = childEnvironment(f.layout);
  assert.equal(env.HOME, process.env.HOME); assert.equal(env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(env.DEVSPACE_CONFIG_DIR, f.layout.devspaceConfigDir); assert.equal(env.NODE_OPTIONS, undefined);
  await fs.unlink(path.join(f.layout.devspaceConfigDir, 'auth.json'));
  await assert.rejects(initializeState({ ...f.options, '--allowed-root': [f.workspace], '--backend-port': String(f.port) }), /PARTIAL_STATE_REQUIRES_REVIEW/);
});
test('full payload checks reject missing, corrupt and unlisted dependencies without restoring files', async t => {
  const f = await fixture(t);
  assert.equal((await verifyPayload(f.layout)).files, f.manifest.files.length);
  const target = path.join(f.payload, 'router', 'agent.js');
  const original = await fs.readFile(target);
  await fs.writeFile(target, 'changed');
  await assert.rejects(verifyPayload(f.layout), error => error.code === 'PAYLOAD_HASH_MISMATCH' && error.evidence.relativePath === 'router/agent.js');
  await fs.unlink(target);
  await assert.rejects(verifyPayload(f.layout), error => error.code === 'PAYLOAD_FILE_MISSING' && error.evidence.actualSha256 === null);
  await fs.writeFile(target, original);
  await fs.writeFile(path.join(f.payload, 'unlisted.txt'), 'unexpected');
  await assert.rejects(verifyPayload(f.layout), /UNMANIFESTED_PAYLOAD_FILE/);
});
test('restart verification handles case-varied manifest names and does not skip required files', async t => {
  const f = await fixture(t);
  // Exercise mixed-case required filenames even on case-sensitive hosts: an
  // uppercase-only manifest can otherwise fail on an unrelated earlier file.
  for (const relative of ['node/LICENSE', 'devspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
    const file = path.join(f.payload, ...relative.split('/'));
    const bytes = await fs.readFile(file);
    await fs.unlink(file);
    await assert.rejects(verifyPayload(f.layout, { criticalOnly: true }), error => error.code === 'PAYLOAD_FILE_MISSING' && error.evidence.relativePath === relative);
    await fs.writeFile(file, bytes);
  }
  const varied = { ...f.manifest, files: f.manifest.files.map(entry => ({ ...entry, path: entry.path.toUpperCase() })) };
  await fs.writeFile(f.manifestPath, JSON.stringify(varied));
  const pin = await digest(f.manifestPath);
  // On a case-sensitive host these paths are absent; on Windows remove one.
  await fs.unlink(path.join(f.payload, 'node', 'LICENSE'));
  await assert.rejects(verifyPayload({ ...f.layout, manifestSha256: pin }, { criticalOnly: true }), /PAYLOAD_FILE_MISSING/);
});
test('pinned manifest validates the exact bytes parsed; a new manifest cannot reuse the previous pin', async t => {
  const f = await fixture(t);
  const changed = structuredClone(f.manifest);
  changed.files.find(file => file.path === 'router/agent.js').sha256 = sha('changed');
  await fs.writeFile(f.manifestPath, JSON.stringify(changed));
  await fs.writeFile(path.join(f.payload, 'router', 'agent.js'), 'changed');
  await assert.rejects(verifyPayload(f.layout), /MANIFEST_HASH_MISMATCH/);
});
test('manifest duplicates, path escapes and a symlinked payload fail closed', async t => {
  const f = await fixture(t);
  for (const relative of ['../escape', 'node/NODE.EXE', 'router/aux.js']) {
    const changed = structuredClone(f.manifest); changed.files.push({ path: relative, sha256: 'b'.repeat(64) });
    await fs.writeFile(f.manifestPath, JSON.stringify(changed));
    await assert.rejects(verifyPayload({ ...f.layout, manifestSha256: await digest(f.manifestPath) }), /INVALID_PAYLOAD/);
  }
  if (process.platform !== 'win32') {
    await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const license = path.join(f.payload, 'node', 'LICENSE');
    await fs.unlink(license); await fs.symlink(f.manifestPath, license);
    await assert.rejects(verifyPayload(f.layout), /REPARSE_POINT_REJECTED/);
  }
});
test('state and version pointers cannot leave the installation tree', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveLayout({ ...f.options, '--state-dir': path.dirname(f.root) }), /INVALID_STATE_DIRECTORY/);
  await assert.rejects(resolveLayout({ ...f.options, '--version-dir': f.root, '--manifest-sha256': f.pin }), /VERSION_DIRECTORY_OUTSIDE_INSTALL/);
  await atomicJson(path.join(f.root, 'current.json'), { schemaVersion: 1, versionId: '..', manifestSha256: f.pin });
  await assert.rejects(resolveLayout(f.options), /INVALID_VERSION_POINTER/);
  for (const versionId of ['CON', 'bad.', 'x'.repeat(81)]) {
    await atomicJson(path.join(f.root, 'current.json'), { schemaVersion: 1, versionId, manifestSha256: f.pin });
    await assert.rejects(resolveLayout(f.options), /INVALID_VERSION_POINTER/);
  }
});
test('backend recovers from more than three real child-process exits and then becomes healthy', async t => {
  const f = await fixture(t, { backend: { crashes: 4, crashAfterMs: 70 } });
  const running = run(t, f);
  try {
    await until(async () => (await f.count('backend')) >= 5 && (await f.receipt())?.status === 'local-ready', 60000);
  } catch (error) {
    t.diagnostic(JSON.stringify({ backendStarts: await f.count('backend'), receipt: await f.receipt(),
      events: await fs.readFile(path.join(f.root, 'logs', 'runtime.jsonl'), 'utf8').catch(() => '') }));
    throw error;
  }
  running.controller.abort();
  assert.equal((await running.promise).passed, true);
  assert.equal(await f.count('backend'), 5);
});
test('Agent never starts before owned backend readiness, even across a virtual delay beyond three minutes', async t => {
  const f = await fixture(t, { pair: true });
  let probes = 0, virtual = 0, ready = false;
  const running = run(t, f, { now: () => performance.now() + virtual, startupGraceMs: 1000000,
    healthFn: async () => { virtual += 60000; probes++; ready = probes >= 5; if (!ready) assert.equal(await f.count('agent'), 0); return ready; } });
  await until(async () => (await f.count('agent')) === 1);
  assert.ok(virtual >= 300000); assert.ok(ready);
  running.controller.abort(); assert.equal((await running.promise).passed, true);
});
test('terminal authorization rejection is persisted, never retried at logon, and does not kill local backend', async t => {
  const f = await fixture(t, { pair: true, token: 'reject' });
  const first = run(t, f);
  try {
    await until(async () => (await f.receipt())?.status === 'agent-blocked', 20000);
  } catch (error) {
    t.diagnostic(JSON.stringify({ agentStarts: await f.count('agent'), receipt: await f.receipt(),
      events: (await fs.readFile(path.join(f.root, 'logs', 'runtime.jsonl'), 'utf8').catch(() => '')).slice(-6000) }));
    throw error;
  }
  assert.equal(await f.count('agent'), 1);
  await pause(100); assert.equal(await f.count('agent'), 1);
  const receipt = await f.receipt(); assert.ok(receipt.backendPid);
  first.controller.abort(); assert.equal((await first.promise).passed, true);
  const second = run(t, f);
  await until(async () => (await f.receipt())?.status === 'agent-blocked');
  assert.equal(await f.count('agent'), 1);
  await control({ ...f.options, '--action': 'enable' });
  await until(async () => (await f.count('agent')) === 2 && (await f.receipt())?.status === 'agent-blocked');
  second.controller.abort(); await second.promise;
  const log = await fs.readFile(path.join(f.root, 'logs', 'runtime.jsonl'), 'utf8');
  assert.ok(!log.includes('private-token-DO-NOT-LOG')); assert.ok(!log.includes('agentToken'));
});
test('missing dependency before backend restart stops with exact hash evidence and no automatic repair', async t => {
  const f = await fixture(t, { backend: { crashes: 1, crashAfterMs: 300 } });
  const running = run(t, f);
  await until(async () => (await f.count('backend')) === 1);
  await fs.unlink(path.join(f.payload, 'node', 'LICENSE'));
  const result = await running.promise;
  assert.equal(result.passed, false);
  assert.equal(result.failed.code, 'PAYLOAD_FILE_MISSING');
  assert.equal(result.failed.relativePath, 'node/LICENSE');
  assert.equal(result.failed.actualSha256, null);
  assert.equal(await f.count('backend'), 1);
  await assert.rejects(fs.stat(path.join(f.payload, 'node', 'LICENSE')), { code: 'ENOENT' });
});
test('stale instance stop is rejected; explicit Stop persists off across a later supervisor launch', async t => {
  const f = await fixture(t);
  const running = run(t, f);
  const receipt = await until(async () => { const value = await f.receipt(); return value?.status === 'local-ready' && value; });
  await assert.rejects(control({ ...f.options, '--action': 'stop', '--instance-id': 'stale' }), /SUPERVISOR_INSTANCE_CHANGED/);
  assert.equal((await json(path.join(f.layout.stateDir, 'enabled.json'))).enabled, true);
  const stopped = await control({ ...f.options, '--action': 'stop', '--instance-id': receipt.instanceId, '--timeout-ms': '5000' });
  assert.equal(stopped.stopped, true); assert.equal((await running.promise).passed, true);
  assert.equal((await json(path.join(f.layout.stateDir, 'enabled.json'))).enabled, false);
  const before = await f.count('backend');
  assert.equal((await supervise(f.options, { tickMs: 10 })).passed, true);
  assert.equal(await f.count('backend'), before);
  assert.equal((await control({ ...f.options, '--action': 'stop' })).stopped, true);
});
test('quiesce preserves enabled intent and duplicate supervisors cannot overwrite the running receipt', async t => {
  const f = await fixture(t);
  const running = run(t, f);
  const receipt = await until(async () => { const value = await f.receipt(); return value?.status === 'local-ready' && value; });
  await assert.rejects(supervise(f.options), /SUPERVISOR_ALREADY_RUNNING/);
  assert.equal((await f.receipt()).instanceId, receipt.instanceId);
  await control({ ...f.options, '--action': 'quiesce', '--instance-id': receipt.instanceId, '--timeout-ms': '5000' });
  assert.equal((await running.promise).passed, true);
  assert.equal((await json(path.join(f.layout.stateDir, 'enabled.json'))).enabled, true);
});
test('forced termination of an unresponsive owned child is recorded as incomplete graceful acceptance', async t => {
  const f = await fixture(t, { backend: { ignoreStop: true } });
  const running = run(t, f, { stopGraceMs: 20 });
  await until(async () => (await f.receipt())?.status === 'local-ready');
  running.controller.abort();
  const result = await running.promise;
  assert.equal(result.cleanShutdown, false); assert.equal(result.passed, false);
  assert.equal((await f.receipt()).cleanShutdown, false);
});
test('runtime logs retain at most two bounded files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codas-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = await createLogger(dir, { maxBytes: 256 });
  for (let i = 0; i < 40; i++) await log('retry', { attempt: i });
  const names = await fs.readdir(dir); assert.equal(names.length, 2);
  for (const name of names) assert.ok((await fs.stat(path.join(dir, name))).size <= 256);
});
test('installed probe waits for owned startup readiness then executes the real local OAuth/MCP flow', async t => {
  const f = await fixture(t, { backend: { healthDelayMs: 250 } });
  const running = run(t, f);
  const result = await probe({ ...f.options, '--workspace': f.workspace, '--timeout-ms': '180000' });
  assert.equal(result.authenticated, true); assert.equal(result.hostname.toLowerCase(), os.hostname().toLowerCase());
  assert.equal(result.remoteAcceptance, false);
  running.controller.abort(); assert.equal((await running.promise).passed, true);
});
test('real supervisor crash releases the OS lock and a new process starts without deleting lock evidence', async t => {
  const f = await fixture(t);
  const launched = [];
  const processObservation = pid => {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Expected an owned child PID from the ready receipt');
    try { process.kill(pid, 0); return { pid, exited: false }; }
    catch (error) { if (error.code === 'ESRCH') return { pid, exited: true }; throw error; }
  };
  const waitForOwnedExit = async receipt => {
    if (!receipt) return;
    const pids = [receipt.leasePid, receipt.backendPid].filter(pid => pid != null);
    await until(() => pids.every(pid => processObservation(pid).exited), 20000);
  };
  const launch = () => {
    const child = spawn(f.layout.node, [path.join(f.layout.runtimeDir, 'supervisor.mjs'), '--install-root', f.root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const output = { stdout: '', stderr: '', spawnError: null };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', chunk => { output[name] = (output[name] + chunk).slice(-4096); });
    }
    const done = new Promise(resolve => {
      child.once('exit', resolve);
      child.once('error', error => { output.spawnError = error.code || error.name; resolve(null); });
    });
    const running = { child, done, output, receipt: null };
    launched.push(running);
    f.cleanupTasks.push(async () => {
      if (!output.spawnError && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
      // Observe EOF/IPC cleanup as well before Windows removes held files.
      await waitForOwnedExit(running.receipt);
    });
    return running;
  };
  const ready = (running, timeout) => until(async () => {
    if (running.output.spawnError || running.child.exitCode !== null || running.child.signalCode !== null) throw new Error('Fixture supervisor exited before readiness');
    const receipt = await f.receipt();
    if (receipt?.pid !== running.child.pid) return false;
    running.receipt = receipt;
    return receipt.status === 'local-ready' && receipt;
  }, timeout);
  let phase = 'first-start';
  try {
    const first = launch();
    const prior = await ready(first, 15000);
    assert.ok(Number.isSafeInteger(prior.leasePid) && prior.leasePid > 0);
    assert.ok(Number.isSafeInteger(prior.backendPid) && prior.backendPid > 0);
    const ledger = await json(path.join(f.layout.stateDir, 'session-generation.json'));
    first.child.kill('SIGKILL'); await first.done;
    // The PowerShell helper must actually observe stdin EOF and the backend must
    // actually exit after IPC disconnect. Neither child is killed by this wait.
    phase = 'prior-owned-children-exit';
    await waitForOwnedExit(prior);
    phase = 'second-start';
    const second = launch();
    const current = await ready(second, 20000);
    assert.notEqual(current.instanceId, prior.instanceId);
    assert.equal((await json(path.join(f.layout.stateDir, 'previous-supervisor.json'))).instanceId, prior.instanceId);
    assert.ok((await json(path.join(f.layout.stateDir, 'session-generation.json'))).next > ledger.next);
    assert.ok(await fs.stat(path.join(f.layout.stateDir, 'runtime-owner.lock')));
    phase = 'second-quiesce';
    await control({ ...f.options, '--action': 'quiesce', '--instance-id': current.instanceId, '--timeout-ms': '10000' });
    assert.equal(await second.done, 0);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase,
      receipt: await f.receipt().catch(failure => ({ readError: failure.code || failure.name })),
      children: launched.map(({ child, output, receipt }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, ...output,
        owned: [receipt?.leasePid, receipt?.backendPid].filter(pid => pid != null).map(pid => processObservation(pid)) }))
    }).slice(-20000));
    throw error;
  }
});
test('stale receipt PID reuse never kills a foreign live process or blocks a free OS lease', async t => {
  const f = await fixture(t);
  const stale = { schemaVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', pid: process.pid, nodePath: process.execPath, args: ['foreign-process'], startedAt: new Date().toISOString(), versionId: 'candidate-test', status: 'running' };
  await atomicJson(path.join(f.layout.stateDir, 'supervisor.json'), stale);
  await fs.writeFile(path.join(f.layout.stateDir, 'runtime-owner.lock'), 'retained foreign contents');
  const running = run(t, f);
  await until(async () => (await f.receipt())?.status === 'local-ready');
  assert.equal((await json(path.join(f.layout.stateDir, 'previous-supervisor.json'))).pid, process.pid);
  running.controller.abort(); assert.equal((await running.promise).passed, true);
  assert.equal(await fs.readFile(path.join(f.layout.stateDir, 'runtime-owner.lock'), 'utf8'), 'retained foreign contents');
});
test('corrupt prior receipt is preserved and rejection releases the new OS lease', async t => {
  const f = await fixture(t);
  const receipt = path.join(f.layout.stateDir, 'supervisor.json');
  let phase = 'seed-corrupt-receipt', settlement = null;
  try {
    await fs.writeFile(receipt, '{broken');
    phase = 'corrupt-receipt-rejection';
    await assert.rejects(supervise(f.options), /INVALID_JSON/);
    phase = 'corrupt-receipt-preserved';
    assert.equal(await fs.readFile(receipt, 'utf8'), '{broken');
    phase = 'operator-repair';
    await fs.unlink(receipt); // Explicit fixture operator repair, not runtime recovery.
    phase = 'second-start';
    const running = run(t, f);
    // Observe an early return/rejection immediately instead of reporting only
    // a later readiness timeout. The original promise remains the stop assertion.
    running.promise.then(
      result => { settlement = { status: 'returned', result }; },
      error => { settlement = { status: 'rejected', failure: safeFailure(error) }; }
    );
    await until(async () => {
      if (settlement) throw new Error('Fixture supervisor ended before readiness');
      return (await f.receipt())?.status === 'local-ready';
    });
    phase = 'second-stop';
    running.controller.abort(); assert.equal((await running.promise).passed, true);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, supervisor: settlement,
      receipt: await f.receipt().catch(failure => ({ readError: safeFailure(failure) })),
      events: await fs.readFile(path.join(f.root, 'logs', 'runtime.jsonl'), 'utf8').then(value => value.slice(-6000), failure => ({ readError: safeFailure(failure) }))
    }).slice(-20000));
    throw error;
  }
});
