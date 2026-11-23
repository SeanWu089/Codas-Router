import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, atomicJson, installation, json, noLinks, resolveLayout, RuntimeFault, safeFailure, verifyPayload } from './common.mjs';

export async function initializeState(options) {
  const layout = await resolveLayout(options);
  await verifyPayload(layout);
  const roots = options['--allowed-root'];
  const port = Number(options['--backend-port']);
  if (!Array.isArray(roots) || !roots.length || roots.some(root => !path.isAbsolute(root))) throw new RuntimeFault('EXPLICIT_ALLOWED_ROOT_REQUIRED');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RuntimeFault('INVALID_BACKEND_PORT');
  const allowedRoots = [...new Set(roots.map(root => path.resolve(root)))];
  for (const root of allowedRoots) {
    await noLinks(root);
    if (!(await fs.stat(root)).isDirectory()) throw new RuntimeFault('ALLOWED_ROOT_NOT_DIRECTORY');
  }
  const lock = `${layout.stateDir}.initialize-lock`;
  await fs.mkdir(path.dirname(layout.stateDir), { recursive: true });
  try { await fs.mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new RuntimeFault('STATE_INITIALIZATION_LOCKED'); throw error; }
  let staging;
  try {
    try {
      const existing = await installation(layout);
      if (existing.backendPort !== port || JSON.stringify(existing.allowedRoots) !== JSON.stringify(allowedRoots)) throw new RuntimeFault('EXISTING_STATE_SETTINGS_DIFFER');
      const config = await json(path.join(layout.devspaceConfigDir, 'config.jsonc'));
      const auth = await json(path.join(layout.devspaceConfigDir, 'auth.json'));
      const enabled = await json(path.join(layout.stateDir, 'enabled.json'));
      if (config.server?.port !== port || config.server?.host !== '127.0.0.1' || JSON.stringify(config.workspaces?.allowedRoots) !== JSON.stringify(allowedRoots) || typeof auth.ownerToken !== 'string' || auth.ownerToken.length < 32 || enabled.schemaVersion !== 1 || typeof enabled.enabled !== 'boolean') throw new RuntimeFault('EXISTING_STATE_INCOMPLETE');
      return { passed: true, newlyCreated: false, installationId: existing.installationId, backendPort: port, remotePaired: await fs.stat(layout.agentConfig).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A partial initialization must never silently acquire a fresh identity.
    const existingNames = await fs.readdir(layout.stateDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (existingNames.length) throw new RuntimeFault('PARTIAL_STATE_REQUIRES_REVIEW');
    staging = `${layout.stateDir}.initializing-${randomUUID()}`;
    await fs.mkdir(path.join(staging, 'devspace'), { recursive: true, mode: 0o700 });
    const installationId = randomUUID();
    const value = { schemaVersion: 1, installationId, deviceId: `device-${installationId}`, backendPort: port, allowedRoots, createdAt: new Date().toISOString() };
    const config = {
      configVersion: 1,
      server: { host: '127.0.0.1', port, publicBaseUrl: `http://127.0.0.1:${port}` },
      workspaces: { allowedRoots, worktreeRoot: path.join(layout.stateDir, 'worktrees') },
      storage: { stateDir: path.join(layout.stateDir, 'devspace-storage') },
      tools: { mode: 'codex' },
      skills: { enabled: false, paths: [], agentDir: path.join(layout.stateDir, 'agents') },
      subagents: { enabled: false, instructions: 'on-demand', providers: [] },
      logging: { level: 'warn', format: 'json', requests: false, assets: false, toolCalls: true, shellCommands: false }
    };
    await atomicJson(path.join(staging, 'installation.json'), value, { exclusive: true });
    await atomicJson(path.join(staging, 'devspace', 'config.jsonc'), config, { exclusive: true });
    await atomicJson(path.join(staging, 'devspace', 'auth.json'), { ownerToken: randomBytes(32).toString('base64url') }, { exclusive: true });
    await atomicJson(path.join(staging, 'enabled.json'), { schemaVersion: 1, enabled: true }, { exclusive: true });
    try { await fs.rmdir(layout.stateDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(staging, layout.stateDir);
    staging = undefined;
    return { passed: true, newlyCreated: true, installationId, backendPort: port, remotePaired: false };
  } finally {
    // Partial staging is intentionally retained for diagnosis; never regenerate
    // a damaged established identity or remove an unknown directory.
    await fs.rmdir(lock);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(await initializeState(args(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ passed: false, ...safeFailure(error) })); process.exitCode = 1; }
}
