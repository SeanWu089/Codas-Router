import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, installation, json, resolveLayout, RuntimeFault, safeFailure, verifyPayload } from './common.mjs';

const sendParent = message => { if (process.connected) process.send(message, () => {}); };
export async function runWorker(options, { send = sendParent } = {}) {
  const layout = await resolveLayout(options);
  await verifyPayload(layout, { criticalOnly: true });
  const installed = await installation(layout);
  const config = await json(layout.agentConfig);
  const router = new URL(config.routerUrl);
  if (router.protocol !== 'https:' || router.username || router.password || router.pathname !== '/' || router.search || router.hash || config.version !== 1 || config.device?.id !== installed.deviceId || config.device?.installationId !== installed.installationId || JSON.stringify(config.device?.roots) !== JSON.stringify(installed.allowedRoots) || config.devspace?.baseUrl !== `http://127.0.0.1:${installed.backendPort}` || path.resolve(config.devspace?.ownerTokenPath || '.') !== path.join(layout.devspaceConfigDir, 'auth.json')) throw new RuntimeFault('AGENT_CONFIGURATION_MISMATCH');
  const { AgentConfigStore } = await import(pathToFileURL(path.join(layout.payloadRoot, 'router', 'agent-config.js')).href);
  const { runAgent } = await import(pathToFileURL(path.join(layout.payloadRoot, 'router', 'agent.js')).href);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('disconnect', stop);
  process.on('message', message => { if (message?.type === 'stop') stop(); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  send({ type: 'worker-started' });
  try {
    await runAgent({ configStore: new AgentConfigStore(layout.agentConfig), transport: 'sse', signal: controller.signal });
    if (!controller.signal.aborted) throw new RuntimeFault('AGENT_RETURNED_UNEXPECTEDLY');
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    if ([401, 403, 409].includes(error?.status)) {
      send({ type: 'terminal', code: 'REMOTE_AUTH_OR_OWNERSHIP_REJECTED', status: error.status });
      return 77;
    }
    send({ type: 'worker-error', ...safeFailure(error) });
    return error instanceof RuntimeFault ? 78 : 75;
  } finally {
    process.removeListener('disconnect', stop);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exitCode = await runWorker(args(process.argv.slice(2))); }
  catch (error) { sendParent({ type: 'terminal', ...safeFailure(error) }); process.exitCode = 78; }
  if (process.connected) process.disconnect();
}
