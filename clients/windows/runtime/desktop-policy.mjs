import { Buffer } from 'node:buffer';
// The user selects the HTTPS origin locally. Bind every persisted config
// read and write to that exact origin for the lifetime of this worker.
export function validateOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = /^https:\/\/([a-z0-9.-]+)(?::443)?\/?$/i.exec(raw);
  if (!match || match[0] !== raw) throw Error('HTTPS_ORIGIN_REQUIRED');
  const host = match[1].toLowerCase();
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 ||
      !/^[a-z][a-z0-9-]*$/.test(labels.at(-1)) ||
      labels.some(label => label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw Error('HTTPS_ORIGIN_REQUIRED');
  }
  return 'https://' + host;
}
export function pinnedConfigStore(store, origin) {
  const expected = validateOrigin(origin);
  function checked(value) {
    let actual;
    try { actual = validateOrigin(value?.routerUrl); }
    catch { throw Error('LEGACY_INGRESS_RETIRED'); }
    if (actual !== expected) throw Error('PAIRING_PROFILE_MISMATCH');
    return {...value, routerUrl:actual};
  }
  return {async load(){return checked(await store.load());},
    async save(value){return store.save(checked(value));}};
}
// Diagnostic only; authenticated SSE readiness is independent.
export async function probeCoordinator(origin, fetchImpl=fetch) {
  const base = validateOrigin(origin);
  try {
    const r=await fetchImpl(base+'/_codassol/health',{
      redirect:'error',signal:AbortSignal.timeout(4500),cache:'no-store'
    });
    if(!r.ok) {await r.body?.cancel();return [401,403,407].includes(r.status)?'rejected':'http_error';}
    const body=await r.json();
    return body?.ok===true?'reachable':'invalid_response';
  } catch {return 'unreachable';}
}
// The adapter accepts only the existing MCP transport, not a general HTTP proxy.
// A tool request needs a fresh, explicit local confirmation.
export function classifyJob(job) {
  const request = job?.payload?.request;
  if (job?.payload?.type !== 'devspace-http' || !request ||
      (request.path || '/mcp') !== '/mcp' ||
      (request.method || 'POST').toUpperCase() !== 'POST') return {type:'deny'};
  const encoded = request.bodyBase64;
  if (typeof encoded !== 'string' || encoded.length > 32768 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return {type:'deny'};
  let body;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return {type:'deny'};
    body = JSON.parse(bytes.toString('utf8'));
  } catch { return {type:'deny'}; }
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      body.jsonrpc !== '2.0') return {type:'deny'};
  if (['initialize','notifications/initialized','tools/list','ping'].includes(body.method)) {
    return {type:'protocol'};
  }
  if (body.method !== 'tools/call' || typeof body.params?.name !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,120}$/.test(body.params.name)) return {type:'deny'};
  const description = JSON.stringify(body.params, null, 2);
  if (!description || description.length > 16000) return {type:'deny'};
  return {type:'confirm', name: body.params.name, description};
}
export function canApprove({enabled, connected, expiresAt, now = Date.now()}) {
  return enabled === true && connected === true &&
    (expiresAt == null || (Number.isSafeInteger(expiresAt) && expiresAt > now));
}

// A grant is selected explicitly on this foreground worker's local start.
// It is not read from a persisted pairing profile or any remote request.
// Limit the grant to the existing, advertised Codex tool surface.
const sessionTools = new Set(['open_workspace','read','apply_patch','exec_command','write_stdin','show_changes']);
export async function authorizeSessionTool({mode,kind,job,getState,verifyBackend}) {
  const permitted=()=>mode==='session-v1' && kind?.type==='confirm' &&
    sessionTools.has(kind.name) && Number.isSafeInteger(job?.expiresAt) &&
    canApprove({...getState(),expiresAt:job.expiresAt});
  if(!permitted())return false;
  try {await verifyBackend();} catch {return false;}
  return permitted();
}
