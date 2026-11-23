import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, atomicJson, backoff, childEnvironment, delay, digest, installation, json, noLinks, resolveLayout, RuntimeFault, safeFailure, settlesWithin, validVersionId, verifyPayload } from './common.mjs';
import { createLogger } from './log.mjs';
import { acquireRuntimeLease } from './lease.mjs';

async function exists(file) { return fs.lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }); }
export async function health(baseUrl, signal) {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) return false;
    let size = 0, body = '';
    for await (const part of response.body) {
      size += part.length;
      if (size > 8192) return false;
      body += Buffer.from(part).toString('utf8');
    }
    const value = JSON.parse(body);
    return value?.ok === true && value?.name === 'devspace';
  } catch { return false; }
}

export async function supervise(options, {
  signal,
  tickMs = 1000,
  healthIntervalMs = 5000,
  startupGraceMs = 180000,
  stopGraceMs = 10000,
  backoffFn = backoff,
  now = () => performance.now(),
  healthFn = health,
  onEvent = async () => {}
} = {}) {
  const layout = await resolveLayout(options);
  const log = await createLogger(layout.logDir);
  const event = async (type, fields = {}) => { await log(type, fields); await onEvent(type, fields); };
  try { await verifyPayload(layout, { criticalOnly: true }); }
  catch (error) { await event('dependency-validation-failed', safeFailure(error)); throw error; }
  const installed = await installation(layout);
  const config = await json(path.join(layout.devspaceConfigDir, 'config.jsonc'));
  if (config.server?.host !== '127.0.0.1' || config.server?.port !== installed.backendPort || config.server?.publicBaseUrl !== `http://127.0.0.1:${installed.backendPort}` || JSON.stringify(config.workspaces?.allowedRoots) !== JSON.stringify(installed.allowedRoots) || config.storage?.stateDir !== path.join(layout.stateDir, 'devspace-storage')) throw new RuntimeFault('BACKEND_CONFIGURATION_MISMATCH');
  const ownerAuth = await json(path.join(layout.devspaceConfigDir, 'auth.json'));
  if (typeof ownerAuth.ownerToken !== 'string' || ownerAuth.ownerToken.length < 32) throw new RuntimeFault('BACKEND_AUTHENTICATION_STATE_INVALID');
  const controller = new AbortController();
  const abort = () => controller.abort();
  let leaseLost = false;
  const lease = await acquireRuntimeLease(layout, { onLost: () => { leaseLost = true; abort(); } });
  const instanceId = randomUUID();
  const receiptPath = path.join(layout.stateDir, 'supervisor.json');
  const receipt = { schemaVersion: 1, instanceId, pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    nodePath: process.execPath, args: process.argv.slice(1), versionId: layout.versionId, status: 'starting', backendPid: null, agentPid: null, leasePid: lease.pid, remoteExecutionVerified: false };
  try {
    const previous = await json(receiptPath, 32768).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous) {
      if (previous.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(previous.instanceId || '') || !validVersionId(previous.versionId) || !Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new RuntimeFault('PREVIOUS_SUPERVISOR_RECORD_INVALID');
      if (previous.status !== 'stopped' || previous.cleanShutdown !== true) {
        // Acquiring the OS lease proves no cooperating supervisor owns it.
        // Never kill/delete a process merely because this old receipt names it.
        await atomicJson(path.join(layout.stateDir, 'previous-supervisor.json'), previous);
        await event('previous-runtime-evidence-retained', { previousInstanceId: previous.instanceId, previousPid: previous.pid });
      }
    }
  } catch (error) {
    try { await lease.release(); } catch { /* retain the prior-receipt error */ }
    throw error;
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const environment = childEnvironment(layout);
  environment.CODAS_WINDOWS_BACKEND_PORT = String(installed.backendPort);
  const workerArgs = ['--install-root', layout.installRoot, '--version-dir', layout.versionDir, '--manifest-sha256', layout.manifestSha256, '--state-dir', layout.stateDir];
  let backend, agent, cleanShutdown = true, failed = null, failureCause;
  let backendFailures = 0, agentFailures = 0, backendRetry = 0, agentRetry = 0, backendStarts = 0;
  let backendReady = false, healthFailures = 0, nextHealth = 0, nextReceipt = 0;
  let lastAgentStatus = '', lastBlockedHash = '';

  const publish = async (status, details = {}) => {
    Object.assign(receipt, { status, updatedAt: new Date().toISOString(), backendPid: backend && !backend.exited ? backend.child.pid : null,
      agentPid: agent && !agent.exited ? agent.child.pid : null }, details);
    await atomicJson(receiptPath, receipt);
  };
  const stopRequested = async () => {
    const enabled = await json(path.join(layout.stateDir, 'enabled.json'), 4096);
    if (enabled.schemaVersion !== 1 || typeof enabled.enabled !== 'boolean') throw new RuntimeFault('INVALID_ENABLED_STATE');
    if (!enabled.enabled || controller.signal.aborted) return true;
    const requestFile = path.join(layout.stateDir, 'stop-request.json');
    if (!await exists(requestFile)) return false;
    const request = await json(requestFile, 4096);
    return request.schemaVersion === 1 && request.instanceId === instanceId;
  };
  const verificationProgress = async verification => {
    await publish('verifying', { verification });
    if (await stopRequested()) { abort(); throw new RuntimeFault('STOP_REQUESTED'); }
  };
  const launch = (role, argv) => {
    const child = spawn(layout.node, argv, { cwd: layout.stateDir, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const record = { role, child, born: now(), exited: false, code: null, signal: null, terminal: null, listening: false, bytes: { stdout: 0, stderr: 0 }, hashes: { stdout: createHash('sha256'), stderr: createHash('sha256') } };
    record.done = new Promise(resolve => {
      child.on('error', () => { if (!child.pid) { record.exited = true; record.code = -1; resolve(); } });
      child.once('exit', (code, signal_) => { record.exited = true; record.code = code; record.signal = signal_; resolve(); });
    });
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', chunk => { record.bytes[stream] += chunk.length; record.hashes[stream].update(chunk); });
    child.on('message', message => {
      if (message?.type === 'backend-listening' && role === 'backend' && message.port === installed.backendPort) { record.listening = true; nextHealth = 0; }
      if (message?.type === 'terminal') record.terminal = { code: /^[A-Z0-9_]{1,80}$/.test(message.code || '') ? message.code : 'CHILD_TERMINAL_FAILURE', ...([401, 403, 409].includes(message.status) ? { status: message.status } : {}) };
    });
    return record;
  };
  const exitEvidence = record => ({ component: record.role, pid: record.child.pid ?? null, exitCode: record.code, exitSignal: record.signal,
    stdoutBytes: record.bytes.stdout, stderrBytes: record.bytes.stderr,
    stdoutSha256: record.hashes.stdout.copy().digest('hex'), stderrSha256: record.hashes.stderr.copy().digest('hex'), ...(record.terminal || {}) });
  const stopChild = async record => {
    if (!record || record.exited) return true;
    try { if (record.child.connected) record.child.send({ type: 'stop' }, () => {}); } catch { /* close race; keep the owned handle */ }
    await settlesWithin(record.done, stopGraceMs);
    if (!record.exited) {
      cleanShutdown = false;
      await event('owned-child-force-stop', { component: record.role, pid: record.child.pid });
      // Only the live ChildProcess created by this supervisor is targeted.
      record.child.kill('SIGKILL');
      await settlesWithin(record.done, 3000);
    }
    return record.exited;
  };
  try {
    if (await stopRequested()) abort();
    if (!controller.signal.aborted) {
      await publish('verifying');
      await verifyPayload(layout, { onProgress: verificationProgress });
    }
    await event('supervisor-start', { instanceId, versionId: layout.versionId });
    while (!controller.signal.aborted) {
      const enabled = await json(path.join(layout.stateDir, 'enabled.json'), 4096);
      if (enabled.schemaVersion !== 1 || typeof enabled.enabled !== 'boolean') throw new RuntimeFault('INVALID_ENABLED_STATE');
      if (!enabled.enabled) { await event('user-disabled'); break; }
      const stopFile = path.join(layout.stateDir, 'stop-request.json');
      if (await exists(stopFile)) {
        const request = await json(stopFile, 4096);
        if (request.schemaVersion === 1 && request.instanceId === instanceId) { await event('stop-requested', { instanceId }); break; }
      }
      if (backend?.exited) {
        await event('backend-exited', exitEvidence(backend));
        if (backend.terminal || backend.code === 78) throw new RuntimeFault(backend.terminal?.code || 'BACKEND_STARTUP_REQUIRES_REVIEW');
        await stopChild(agent); agent = undefined; backend = undefined;
        backendReady = false; healthFailures = 0;
        backendRetry = now() + backoffFn(++backendFailures);
      }
      if (!backend && now() >= backendRetry) {
        // Check EVERY dependency before each backend restart; never restore or
        // download missing/quarantined files and never silently reset a ledger.
        if (backendStarts > 0) await verifyPayload(layout, { onProgress: verificationProgress });
        backend = launch('backend', ['--import', pathToFileURL(path.join(layout.runtimeDir, 'backend-preload.mjs')).href, path.join(layout.payloadRoot, 'devspace', 'node_modules', '@waishnav', 'devspace', 'dist', 'cli.js'), 'serve']);
        backendStarts++;
        nextHealth = 0;
        await event('backend-start', { pid: backend.child.pid ?? null, failureCount: backendFailures });
      }
      if (backend && !backend.exited && now() >= nextHealth) {
        nextHealth = now() + healthIntervalMs;
        const ready = backend.listening && await healthFn(`http://127.0.0.1:${installed.backendPort}`, controller.signal);
        if (ready) {
          if (!backendReady) await event('backend-ready', { pid: backend.child.pid });
          backendReady = true; healthFailures = 0;
          if (now() - backend.born >= 60000) backendFailures = 0;
        } else {
          backendReady = false;
          await stopChild(agent); agent = undefined;
          if (now() - backend.born >= startupGraceMs && ++healthFailures >= 3) {
            await event('backend-health-restart', { pid: backend.child.pid, consecutiveFailures: healthFailures });
            await stopChild(backend);
          }
        }
      }
      if (agent?.exited) {
        await event('agent-exited', exitEvidence(agent));
        if (agent.code === 77 || agent.code === 78 || agent.terminal) {
          const fingerprint = await digest(layout.agentConfig);
          await atomicJson(path.join(layout.stateDir, 'agent-block.json'), { schemaVersion: 1, configSha256: fingerprint, reason: agent.terminal?.code || 'AGENT_CONFIGURATION_REJECTED', status: agent.terminal?.status ?? null, at: new Date().toISOString() });
          await event('agent-blocked', { code: agent.terminal?.code || 'AGENT_CONFIGURATION_REJECTED', status: agent.terminal?.status ?? null });
        } else agentRetry = now() + backoffFn(++agentFailures);
        agent = undefined;
      }
      let state = backendReady ? 'local-ready' : 'backend-waiting';
      if (backendReady && await exists(layout.agentConfig)) {
        const fingerprint = await digest(layout.agentConfig);
        const blockFile = path.join(layout.stateDir, 'agent-block.json');
        let block = await json(blockFile, 8192).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (block && (block.schemaVersion !== 1 || typeof block.configSha256 !== 'string')) throw new RuntimeFault('INVALID_AGENT_BLOCK_STATE');
        if (block && block.configSha256 !== fingerprint) { await fs.rm(blockFile); block = null; }
        if (block) {
          state = 'agent-blocked';
          if (lastBlockedHash !== fingerprint) { lastBlockedHash = fingerprint; await event('agent-awaiting-explicit-repair', { code: 'PAIRING_OR_CONFIGURATION_REVIEW_REQUIRED' }); }
        } else if (!agent && now() >= agentRetry) {
          await verifyPayload(layout, { criticalOnly: true });
          agent = launch('agent', [path.join(layout.runtimeDir, 'agent-worker.mjs'), ...workerArgs]);
          await event('agent-start', { pid: agent.child.pid ?? null, failureCount: agentFailures });
        }
        if (agent && !agent.exited) {
          state = 'outbound-running-unverified';
          if (now() - agent.born >= 60000) agentFailures = 0;
        }
      }
      if (state !== lastAgentStatus || now() >= nextReceipt) {
        await publish(state);
        lastAgentStatus = state; nextReceipt = now() + 5000;
      }
      await delay(tickMs, controller.signal);
    }
  } catch (error) {
    if (!(controller.signal.aborted && error.code === 'STOP_REQUESTED')) {
      failureCause = error;
      failed = safeFailure(error);
      try { await event('supervisor-blocked', failed); }
      catch { throw error; } // A diagnostic failure must not replace its cause.
    }
  } finally {
    abort();
    if (leaseLost) failed ||= { code: 'SUPERVISOR_OS_LOCK_LOST' };
    const agentStopped = await stopChild(agent);
    const backendStopped = await stopChild(backend);
    cleanShutdown &&= agentStopped && backendStopped;
    // Enter this cleanup only after the existing owned-child stop operations
    // complete. A failed stopChild must not newly release a live owner's lease.
    let cleanupError;
    try {
      await publish('stopped', { cleanShutdown, failed, stoppedAt: new Date().toISOString() });
      await event('supervisor-stop', { instanceId, cleanShutdown, failed });
    } catch (error) { cleanupError = error; }
    try { await lease.release(); }
    catch (error) { cleanupError ||= error; }
    finally { signal?.removeEventListener('abort', abort); }
    if (cleanupError) throw failureCause || cleanupError;
  }
  return { passed: !failed && cleanShutdown, cleanShutdown, failed, instanceId };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  try {
    const result = await supervise(args(process.argv.slice(2)), { signal: controller.signal });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ passed: false, ...safeFailure(error) })); process.exitCode = 1; }
}
