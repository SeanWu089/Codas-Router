import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, atomicJson, installation, noLinks, resolveLayout, RuntimeFault, safeFailure, verifyPayload } from './common.mjs';

export async function pair(options, input = process.stdin) {
  const layout = await resolveLayout(options);
  await verifyPayload(layout);
  const installed = await installation(layout);
  const origin = new URL(options['--router']);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new RuntimeFault('HTTPS_ROUTER_ORIGIN_REQUIRED');
  await noLinks(layout.agentConfig, { missing: true });
  if (await fs.stat(layout.agentConfig).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new RuntimeFault('ALREADY_PAIRED_PRESERVE_EXISTING_IDENTITY');
  const lock = path.join(layout.stateDir, 'pairing.lock');
  try { await fs.mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new RuntimeFault('PAIRING_LOCKED'); throw error; }
  try {
    let token = '';
    for await (const chunk of input) {
      token += chunk;
      if (token.length > 8192) throw new RuntimeFault('PAIRING_TOKEN_TOO_LARGE');
    }
    token = token.trim();
    if (token.length < 32) throw new RuntimeFault('PAIRING_TOKEN_REQUIRED_ON_STDIN');
    const { enrollAgent } = await import(pathToFileURL(path.join(layout.payloadRoot, 'router', 'agent.js')).href);
    let enrollment;
    const configStore = { async save(value) {
      enrollment = { version: 1, ...value };
      enrollment.device.installationId = installed.installationId;
      enrollment.devspace.ownerTokenPath = path.join(layout.devspaceConfigDir, 'auth.json');
      await atomicJson(layout.agentConfig, enrollment, { exclusive: true });
      return enrollment;
    } };
    try {
      await enrollAgent({ routerUrl: origin.origin, pairingToken: token, deviceId: installed.deviceId, installationId: installed.installationId,
        label: os.hostname(), roots: installed.allowedRoots, devspaceBaseUrl: `http://127.0.0.1:${installed.backendPort}`, configStore });
    } finally { token = ''; }
    // Pairing has external effects. Any failure remains an operator-visible
    // failure; never automatically retry enrollment or reset device identity.
    return { passed: true, paired: true, deviceId: installed.deviceId, routerHost: origin.hostname, remoteExecutionVerified: false };
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(await pair(args(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ passed: false, ...safeFailure(error) })); process.exitCode = 1; }
}
