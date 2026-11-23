import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, contained, delay, installation, json, noLinks, resolveLayout, RuntimeFault, safeFailure, verifyPayload } from './common.mjs';

async function boundedBody(response, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new RuntimeFault('LOCAL_MCP_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function probe(options) {
  const layout = await resolveLayout(options);
  await verifyPayload(layout, { criticalOnly: true });
  const installed = await installation(layout);
  const workspace = options['--workspace'];
  if (!workspace || !path.isAbsolute(workspace) || !installed.allowedRoots.some(root => contained(root, workspace))) throw new RuntimeFault('PROBE_WORKSPACE_NOT_ALLOWED');
  await noLinks(workspace);
  const timeoutMs = Number(options['--timeout-ms'] || 30000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new RuntimeFault('INVALID_PROBE_TIMEOUT');
  const signal = AbortSignal.timeout(timeoutMs);
  const { DevSpaceLocalOAuth } = await import(pathToFileURL(path.join(layout.payloadRoot, 'router', 'devspace-local-auth.js')).href);
  const baseUrl = `http://127.0.0.1:${installed.backendPort}`;
  let readyReceipt;
  const readyStates = ['local-ready', 'outbound-running-unverified', 'agent-blocked'];
  // Startup may be hashing a complete offline dependency tree. A refusal here
  // is readiness progress, not grounds to immediately roll back the install.
  while (!signal.aborted) {
    const receipt = await json(path.join(layout.stateDir, 'supervisor.json'), 32768).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (receipt?.schemaVersion === 1 && receipt.versionId === layout.versionId && Number.isSafeInteger(receipt.backendPid) && receipt.backendPid > 0 && readyStates.includes(receipt.status)) {
      try {
        const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
        const status = JSON.parse(await boundedBody(response, 8192));
        if (response.ok && status.ok === true && status.name === 'devspace') { readyReceipt = receipt; break; }
      } catch { /* wait for the current owned backend until the total deadline */ }
    }
    await delay(250, signal);
  }
  if (!readyReceipt) throw new RuntimeFault('LOCAL_BACKEND_READINESS_TIMEOUT');
  const client = new DevSpaceLocalOAuth({ baseUrl, ownerTokenPath: path.join(layout.devspaceConfigDir, 'auth.json'),
    fetchFn: (url, request = {}) => fetch(url, { ...request, signal }) });
  let rpcId = 0;
  const rpc = async (method, params) => {
    const id = ++rpcId;
    const response = await client.authorizedFetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const body = await boundedBody(response);
    let value;
    if ((response.headers.get('content-type') || '').includes('text/event-stream') || /^\s*(event:|data:)/.test(body)) {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { const candidate = JSON.parse(line.slice(5).trim()); if (candidate.id === id) value = candidate; } catch { /* ignore other events */ }
      }
    } else { try { value = JSON.parse(body); } catch { /* reported below */ } }
    if (!response.ok || value?.id !== id || value?.error || value?.result?.isError) throw new RuntimeFault('LOCAL_MCP_TOOL_REJECTED', { method, httpStatus: response.status });
    return value.result;
  };
  const opened = await rpc('tools/call', { name: 'open_workspace', arguments: { path: path.resolve(workspace) } });
  const workspaceId = opened?.structuredContent?.workspace_id;
  if (typeof workspaceId !== 'string') throw new RuntimeFault('LOCAL_WORKSPACE_NOT_OPENED');
  const ran = await rpc('tools/call', { name: 'exec_command', arguments: { workspace_id: workspaceId, cmd: 'hostname', max_output_tokens: 256, yield_time_ms: 1000 } });
  const data = ran?.structuredContent;
  if (data?.running || data?.exit_code !== 0 || typeof data.result !== 'string') throw new RuntimeFault('LOCAL_COMMAND_DID_NOT_COMPLETE');
  const actual = data.result.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  if (actual?.toLowerCase() !== os.hostname().toLowerCase()) throw new RuntimeFault('LOCAL_HOSTNAME_MISMATCH');
  const after = await json(path.join(layout.stateDir, 'supervisor.json'), 32768);
  if (after.instanceId !== readyReceipt.instanceId || after.backendPid !== readyReceipt.backendPid || after.versionId !== layout.versionId || !readyStates.includes(after.status)) throw new RuntimeFault('LOCAL_BACKEND_CHANGED_DURING_PROBE');
  return { passed: true, authenticated: true, hostname: actual, versionId: layout.versionId, manifestSha256: layout.manifestSha256,
    workspaceOpened: true, harmlessCommandCompleted: true, remoteAcceptance: false };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(await probe(args(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ passed: false, ...safeFailure(error) })); process.exitCode = 1; }
}
