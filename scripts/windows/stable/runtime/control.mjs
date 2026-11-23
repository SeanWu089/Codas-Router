import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, atomicJson, contained, delay, json, noLinks, RuntimeFault, safeFailure } from './common.mjs';

export async function control(options) {
  if (!options['--install-root'] || !path.isAbsolute(options['--install-root'])) throw new RuntimeFault('ABSOLUTE_INSTALL_ROOT_REQUIRED');
  const root = path.resolve(options['--install-root']);
  const state = path.resolve(options['--state-dir'] || path.join(root, 'state'));
  if (state === root || !contained(root, state) || contained(path.join(root, 'versions'), state) || contained(path.join(root, 'bin'), state)) throw new RuntimeFault('INVALID_STATE_DIRECTORY');
  await noLinks(state);
  const enabledPath = path.join(state, 'enabled.json');
  const enabled = await json(enabledPath, 4096);
  if (enabled.schemaVersion !== 1 || typeof enabled.enabled !== 'boolean') throw new RuntimeFault('INVALID_ENABLED_STATE');
  const action = options['--action'];
  const receiptPath = path.join(state, 'supervisor.json');
  const receipt = await json(receiptPath, 32768).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (action === 'status') return { passed: true, enabled: enabled.enabled, supervisor: receipt };
  if (action === 'enable') {
    await atomicJson(enabledPath, { schemaVersion: 1, enabled: true });
    // Explicit Start authorizes one retry; automatic logon never clears this.
    const block = path.join(state, 'agent-block.json');
    await noLinks(block, { missing: true });
    await fs.rm(block, { force: true });
    return { passed: true, enabled: true, taskStarted: false };
  }
  if (!['stop', 'quiesce'].includes(action)) throw new RuntimeFault('INVALID_CONTROL_ACTION');
  const requested = options['--instance-id'];
  if (receipt && receipt.status !== 'stopped') {
    if (!requested || receipt.instanceId !== requested) throw new RuntimeFault('SUPERVISOR_INSTANCE_CHANGED');
  } else if (requested && receipt?.instanceId !== requested) throw new RuntimeFault('SUPERVISOR_INSTANCE_CHANGED');
  if (action === 'stop') await atomicJson(enabledPath, { schemaVersion: 1, enabled: false });
  if (receipt?.status === 'stopped' && receipt.cleanShutdown !== true) throw new RuntimeFault('SUPERVISOR_SHUTDOWN_INCOMPLETE');
  if (!receipt || receipt.status === 'stopped') return { passed: true, enabled: action === 'stop' ? false : enabled.enabled, stopped: true, alreadyStopped: true };
  const timeout = Number(options['--timeout-ms'] || 20000);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000) throw new RuntimeFault('INVALID_CONTROL_TIMEOUT');
  await atomicJson(path.join(state, 'stop-request.json'), { schemaVersion: 1, instanceId: requested, requestedAt: new Date().toISOString() });
  const end = Date.now() + timeout;
  do {
    await delay(200);
    const current = await json(receiptPath, 32768);
    if (current.instanceId !== requested) throw new RuntimeFault('SUPERVISOR_INSTANCE_CHANGED');
    if (current.status === 'stopped') {
      if (current.cleanShutdown !== true) throw new RuntimeFault('SUPERVISOR_SHUTDOWN_INCOMPLETE');
      return { passed: true, stopped: true, instanceId: requested, enabled: action === 'stop' ? false : enabled.enabled };
    }
  } while (Date.now() < end);
  throw new RuntimeFault('SUPERVISOR_STOP_TIMEOUT');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(await control(args(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ passed: false, ...safeFailure(error) })); process.exitCode = 1; }
}
