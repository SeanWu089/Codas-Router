// Engineering qualification only. Not included in, or imported by, the product.
// Never print private router state, enrollment responses, keys, or agent tokens.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID,
  publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv, constants } from 'node:crypto';

const PURPOSE = 'codas-windows-fresh-identity-qualification-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_RUN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HEX = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
function fields(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) fail(code);
}
function options(argv, allowed) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--') || Object.hasOwn(values, name)) fail('INVALID_ARGUMENTS');
    values[name] = value;
  }
  for (const name of allowed) if (!Object.hasOwn(values, name)) fail('REQUIRED_ARGUMENT_MISSING');
  return values;
}
async function noLinks(file, missing = false) {
  let part = path.resolve(file);
  while (true) {
    try { if ((await fs.lstat(part)).isSymbolicLink()) fail('LINKED_PATH_REJECTED'); }
    catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    const parent = path.dirname(part);
    if (parent === part) return;
    part = parent;
  }
}
function absolute(file) {
  if (!path.isAbsolute(file)) fail('EXPLICIT_ABSOLUTE_PATH_REQUIRED');
  return path.resolve(file);
}
function windowsPath(file) {
  if (typeof file !== 'string' || !/^[A-Za-z]:\\/.test(file) || /[\x00-\x1f]/.test(file) || path.win32.resolve(file) !== file || file === path.win32.parse(file).root) fail('NORMAL_WINDOWS_PATH_REQUIRED');
  return file;
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('HTTPS_ORIGIN_REQUIRED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('HTTPS_ORIGIN_REQUIRED');
  return url.origin;
}
async function read(file, limit = 1024 * 1024) {
  await noLinks(file);
  if (!(await fs.stat(file)).isFile() || (await fs.stat(file)).size > limit) fail('FILE_TYPE_OR_SIZE_REJECTED');
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) fail('FILE_SIZE_REJECTED');
  return bytes;
}
async function json(file, limit) {
  const bytes = await read(file, limit);
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('INVALID_JSON_FILE'); }
}
async function exists(file) {
  await noLinks(file, true);
  return fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}
async function writeNew(file, bytes) {
  await noLinks(file, true);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
const writeJsonNew = (file, value) => writeNew(file, canonical(value) + '\n');

async function unpairedWindowsState(root) {
  if (process.platform !== 'win32') fail('WINDOWS_ONLY');
  windowsPath(root);
  await noLinks(root);
  const state = path.join(root, 'state');
  const installed = await json(path.join(state, 'installation.json'), 65536);
  if (installed.schemaVersion !== 1 || !UUID.test(installed.installationId) || installed.deviceId !== `device-${installed.installationId}` || !Number.isInteger(installed.backendPort) || installed.backendPort < 1024 || installed.backendPort > 65535 || !Array.isArray(installed.allowedRoots) || installed.allowedRoots.length !== 1) fail('FRESH_INSTALLATION_STATE_REQUIRED');
  windowsPath(installed.allowedRoots[0]);
  await noLinks(installed.allowedRoots[0]);
  if (!(await fs.stat(installed.allowedRoots[0])).isDirectory()) fail('QUALIFICATION_DIRECTORY_REQUIRED');
  const config = await json(path.join(state, 'devspace', 'config.jsonc'), 65536);
  if (canonical(config.workspaces?.allowedRoots) !== canonical(installed.allowedRoots) || config.server?.host !== '127.0.0.1' || config.server?.port !== installed.backendPort || config.server?.publicBaseUrl !== `http://127.0.0.1:${installed.backendPort}` || config.storage?.stateDir !== path.join(state, 'devspace-storage')) fail('ISOLATED_BACKEND_CONFIGURATION_MISMATCH');
  const enabled = await json(path.join(state, 'enabled.json'), 4096);
  if (enabled.schemaVersion !== 1 || enabled.enabled !== false) fail('STOP_QUALIFICATION_INSTALLATION_FIRST');
  const receiptFile = path.join(state, 'supervisor.json');
  if (await exists(receiptFile)) {
    const receipt = await json(receiptFile, 32768);
    if (receipt.schemaVersion !== 1 || receipt.status !== 'stopped' || receipt.cleanShutdown !== true) fail('CLEAN_STOP_REQUIRED');
  }
  if (await exists(path.join(state, 'agent.json'))) fail('ALREADY_PAIRED_DO_NOT_REPLACE_IDENTITY');
  const auth = await json(path.join(state, 'devspace', 'auth.json'), 65536);
  if (typeof auth.ownerToken !== 'string' || auth.ownerToken.length < 32) fail('EXISTING_LOCAL_AUTH_REQUIRED');
  return { state, installed, ownerTokenPath: path.join(state, 'devspace', 'auth.json') };
}
async function underPairingLock(root, action) {
  const lock = path.join(root, 'state', 'pairing.lock');
  await noLinks(lock, true);
  await fs.mkdir(lock);
  try { return await action(); } finally { await fs.rmdir(lock); }
}
function validateRequest(request) {
  fields(request, ['schemaVersion','purpose','requestId','runId','installRoot','installationId','deviceId','label','platform','allowedRoots','backendPort','ownerTokenPath','routerUrl','publicKeyPem','proof'], 'INVALID_PUBLIC_REQUEST');
  if (request.schemaVersion !== 1 || request.purpose !== PURPOSE || !UUID.test(request.requestId) || !SAFE_RUN.test(request.runId) || !UUID.test(request.installationId) || request.deviceId !== `device-${request.installationId}` || request.platform !== 'win32' || typeof request.label !== 'string' || !/^Codas qualification [A-Za-z0-9 ._-]{1,100}$/.test(request.label)) fail('INVALID_PUBLIC_REQUEST');
  windowsPath(request.installRoot);
  if (!Array.isArray(request.allowedRoots) || request.allowedRoots.length !== 1) fail('ONE_QUALIFICATION_ROOT_REQUIRED');
  windowsPath(request.allowedRoots[0]);
  if (!Number.isInteger(request.backendPort) || request.backendPort < 1024 || request.backendPort > 65535 || request.ownerTokenPath !== path.win32.join(request.installRoot, 'state', 'devspace', 'auth.json') || request.routerUrl !== origin(request.routerUrl)) fail('INVALID_PUBLIC_REQUEST_SCOPE');
  fields(request.proof, ['name','sha256','hostname'], 'INVALID_PROOF_METADATA');
  if (request.proof.name !== `codas-proof-${request.runId}.txt` || !HEX.test(request.proof.sha256) || !/^[A-Za-z0-9._-]{1,80}$/.test(request.proof.hostname)) fail('INVALID_PROOF_METADATA');
  if (typeof request.publicKeyPem !== 'string' || request.publicKeyPem.length > 8192 || !request.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) fail('INVALID_PUBLIC_KEY');
  const key = createPublicKey(request.publicKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) fail('RSA_3072_PUBLIC_KEY_REQUIRED');
  return request;
}
function binding(request) {
  return { schemaVersion: 1, purpose: PURPOSE, requestId: request.requestId, requestSha256: sha(canonical(request)), deviceId: request.deviceId, installationId: request.installationId };
}
function configFor(request, agentToken) {
  return { version: 1, routerUrl: request.routerUrl,
    device: { id: request.deviceId, installationId: request.installationId, label: request.label, platform: 'win32', roots: request.allowedRoots, capabilities: ['devspace-http'] },
    agentToken, devspace: { baseUrl: `http://127.0.0.1:${request.backendPort}`, ownerTokenPath: request.ownerTokenPath, oauth: {} } };
}

async function prepare(values) {
  const root = absolute(values['--install-root']), workspace = absolute(values['--workspace']);
  const runId = values['--run-id'];
  if (!SAFE_RUN.test(runId)) fail('INVALID_RUN_ID');
  return underPairingLock(root, async () => {
    const { state, installed, ownerTokenPath } = await unpairedWindowsState(root);
    if (installed.allowedRoots[0] !== workspace) fail('QUALIFICATION_ROOT_MISMATCH');
    if ((await fs.readdir(workspace)).length !== 0) fail('NEW_EMPTY_QUALIFICATION_DIRECTORY_REQUIRED');
    const hostname = os.hostname();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(hostname)) fail('UNEXPECTED_HOSTNAME');
    const dir = path.join(state, 'qualification-handoff');
    await fs.mkdir(dir, { mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    await writeNew(path.join(dir, 'ephemeral-private.pem'), privateKey);
    const proofName = `codas-proof-${runId}.txt`;
    const proof = `Codas Windows fresh-identity qualification\nrun=${runId}\ndevice=${installed.deviceId}\nhostname=${hostname}\nmarker=${randomBytes(24).toString('hex')}\n`;
    await writeNew(path.join(workspace, proofName), proof);
    const request = validateRequest({ schemaVersion: 1, purpose: PURPOSE, requestId: randomUUID(), runId,
      installRoot: root, installationId: installed.installationId, deviceId: installed.deviceId,
      label: `Codas qualification ${hostname} ${runId}`, platform: 'win32', allowedRoots: installed.allowedRoots,
      backendPort: installed.backendPort, ownerTokenPath, routerUrl: origin(values['--ingress']), publicKeyPem: publicKey,
      proof: { name: proofName, sha256: sha(proof), hostname } });
    await writeJsonNew(path.join(dir, 'request.json'), request);
    return { passed: true, phase: 'prepared', requestFile: path.join(dir, 'request.json'), requestSha256: sha(canonical(request)), deviceId: request.deviceId, label: request.label, proof: request.proof, runtimeEnabled: false };
  });
}

function loopback(value) {
  let url;
  try { url = new URL(value); } catch { fail('LITERAL_LOOPBACK_URL_REQUIRED'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('LITERAL_LOOPBACK_URL_REQUIRED');
  return { hostname: '127.0.0.1', port: Number(url.port) };
}
function requestJson(endpoint, route, method, token, body) {
  const bytes = body === undefined ? null : Buffer.from(canonical(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ ...endpoint, path: route, method, agent: false, headers: {
      authorization: `Bearer ${token}`, accept: 'application/json',
      ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {})
    } }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 256 * 1024) { response.destroy(); request.destroy(); reject(Object.assign(new Error('HTTP_RESPONSE_TOO_LARGE'), { safeCode: 'HTTP_RESPONSE_TOO_LARGE' })); }
        else chunks.push(chunk);
      });
      response.once('error', () => reject(Object.assign(new Error('LOOPBACK_RESPONSE_FAILED'), { safeCode: 'LOOPBACK_RESPONSE_FAILED' })));
      response.once('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(Object.assign(new Error('LOOPBACK_RESPONSE_INVALID'), { safeCode: 'LOOPBACK_RESPONSE_INVALID' })); return; }
        resolve({ status: response.statusCode, value });
      });
    });
    request.setTimeout(15000, () => request.destroy());
    request.once('error', () => reject(Object.assign(new Error('LOOPBACK_REQUEST_FAILED'), { safeCode: 'LOOPBACK_REQUEST_FAILED' })));
    request.end(bytes);
  });
}
function privateState(value) {
  if (value?.version !== 1 || !value.agents || Array.isArray(value.agents) || typeof value.agents !== 'object' || typeof value.installationId !== 'string' || value.installationId.length < 16 || ['pairingToken','adminToken','peerToken'].some(key => typeof value[key] !== 'string' || value[key].length < 32)) fail('EXPLICIT_ROUTER_STATE_INVALID');
  return value;
}
async function enroll(values) {
  if (process.platform !== 'darwin') fail('MAC_LOOPBACK_ONLY');
  const stateFile = absolute(values['--state-file']), output = absolute(values['--output']);
  const request = validateRequest(await json(absolute(values['--request-file']), 32768));
  if (request.routerUrl !== origin(values['--public-origin'])) fail('PUBLIC_INGRESS_MISMATCH');
  const endpoint = loopback(values['--loopback']);
  const before = privateState(await json(stateFile, 16 * 1024 * 1024));
  if (Object.hasOwn(before.agents, request.deviceId)) fail('DEVICE_ID_EXISTS_NEVER_ROTATE');
  const catalogResponse = await requestJson(endpoint, '/_codassol/devices', 'GET', before.adminToken);
  const catalog = catalogResponse.value;
  if (catalogResponse.status !== 200 || catalog?.version !== 1 || catalog.localDeviceId !== values['--expected-router-id'] || !Array.isArray(catalog.devices)) fail('EXPLICIT_PRODUCTION_ROUTER_MISMATCH');
  if (catalog.devices.some(item => item.id === request.deviceId)) fail('DEVICE_ID_EXISTS_IN_CATALOG');
  const local = catalog.devices.find(item => item.id === catalog.localDeviceId);
  if (!local || (local.installationId && local.installationId !== before.installationId)) fail('ROUTER_INSTALLATION_MISMATCH');
  if (await exists(output)) fail('ENVELOPE_ALREADY_EXISTS');
  await noLinks(path.dirname(output));
  // This permanent public marker prevents a second POST after any ambiguous
  // network/result failure. Never retry or remove it automatically.
  await writeJsonNew(`${output}.attempt.json`, { ...binding(request), attemptedAt: new Date().toISOString(), operation: 'single-enrollment-no-retry' });
  const enrolled = await requestJson(endpoint, '/_codassol/agent/enroll', 'POST', before.pairingToken,
    { id: request.deviceId, installationId: request.installationId, label: request.label, platform: 'win32', roots: request.allowedRoots, capabilities: ['devspace-http'] });
  if (enrolled.status !== 201 || enrolled.value?.ok !== true || enrolled.value.deviceId !== request.deviceId || typeof enrolled.value.agentToken !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(enrolled.value.agentToken)) fail('ENROLLMENT_OUTCOME_REQUIRES_REVIEW_DO_NOT_RETRY');
  const header = binding(request), key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext = Buffer.concat([cipher.update(canonical(configFor(request, enrolled.value.agentToken)), 'utf8'), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: request.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  key.fill(0);
  const envelope = { ...header, algorithm: 'RSA-OAEP-SHA256+AES-256-GCM', wrappedKey: wrappedKey.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  await writeJsonNew(output, envelope);
  const after = privateState(await json(stateFile, 16 * 1024 * 1024));
  if (['version','installationId','pairingToken','adminToken','peerToken'].some(name => after[name] !== before[name]) || Object.keys(before.agents).some(id => canonical(before.agents[id]) !== canonical(after.agents[id]))) fail('ENVELOPE_SAVED_EXISTING_ROUTER_STATE_CHANGED_REVIEW');
  const newAgent = after.agents[request.deviceId];
  if (!newAgent || newAgent.label !== request.label || newAgent.platform !== 'win32' || canonical(newAgent.roots) !== canonical(request.allowedRoots) || canonical(newAgent.capabilities) !== canonical(['devspace-http']) || newAgent.tokenHash !== createHash('sha256').update(enrolled.value.agentToken).digest('base64url')) fail('ENVELOPE_SAVED_NEW_AGENT_SCOPE_REQUIRES_REVIEW');
  return { passed: true, phase: 'enrolled-and-encrypted', deviceId: request.deviceId, label: request.label, envelopeFile: output, envelopeSha256: sha(canonical(envelope)), existingIdentityAndCredentialsPreserved: true, enrollmentRequests: 1, remoteExecutionVerified: false };
}

function decode(value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit) fail('INVALID_ENCRYPTED_ENVELOPE');
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value) fail('INVALID_ENCRYPTED_ENVELOPE');
  return result;
}
async function importEnvelope(values) {
  const root = absolute(values['--install-root']);
  return underPairingLock(root, async () => {
    const { state, installed, ownerTokenPath } = await unpairedWindowsState(root);
    const dir = path.join(state, 'qualification-handoff');
    const request = validateRequest(await json(path.join(dir, 'request.json'), 32768));
    if (request.installRoot !== root || request.installationId !== installed.installationId || request.deviceId !== installed.deviceId || canonical(request.allowedRoots) !== canonical(installed.allowedRoots) || request.backendPort !== installed.backendPort || request.ownerTokenPath !== ownerTokenPath) fail('LOCAL_IDENTITY_OR_SCOPE_CHANGED');
    if (sha(await read(path.join(installed.allowedRoots[0], request.proof.name), 8192)) !== request.proof.sha256) fail('LOCAL_PROOF_FILE_CHANGED');
    const envelope = await json(absolute(values['--envelope']), 65536);
    const header = binding(request);
    fields(envelope, [...Object.keys(header), 'algorithm','wrappedKey','iv','tag','ciphertext'], 'INVALID_ENCRYPTED_ENVELOPE');
    if (Object.entries(header).some(([key, value]) => envelope[key] !== value) || envelope.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM') fail('ENVELOPE_IDENTITY_OR_REQUEST_MISMATCH');
    const privateKey = await read(path.join(dir, 'ephemeral-private.pem'), 8192);
    const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, decode(envelope.wrappedKey, 1024));
    const iv = decode(envelope.iv, 32), tag = decode(envelope.tag, 32);
    if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) fail('INVALID_ENCRYPTED_ENVELOPE');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(canonical(header))); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext, 40000)), decipher.final()]);
    key.fill(0); privateKey.fill(0);
    let config;
    try { config = JSON.parse(plaintext.toString('utf8')); } catch { fail('INVALID_ENCRYPTED_CONFIGURATION'); }
    plaintext.fill(0);
    if (typeof config?.agentToken !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(config.agentToken) || canonical(config) !== canonical(configFor(request, config.agentToken))) fail('DECRYPTED_IDENTITY_OR_SCOPE_MISMATCH');
    // Exclusive creation only: never replace an existing enrollment or identity.
    const temp = path.join(state, `qualification-agent-${randomUUID()}.tmp`);
    await writeJsonNew(temp, config);
    try { await fs.link(temp, path.join(state, 'agent.json')); }
    finally { await fs.unlink(temp); }
    await fs.unlink(path.join(dir, 'ephemeral-private.pem'));
    await writeJsonNew(path.join(dir, 'import-receipt.json'), { ...header, importedAt: new Date().toISOString(), envelopeSha256: sha(canonical(envelope)), runtimeEnabled: false });
    return { passed: true, phase: 'imported', deviceId: request.deviceId, label: request.label, allowedRoot: installed.allowedRoots[0], runtimeEnabled: false, remoteExecutionVerified: false, ephemeralPrivateKeyRemoved: true };
  });
}

const commands = {
  prepare: { args: ['--install-root','--workspace','--ingress','--run-id'], fn: prepare },
  enroll: { args: ['--request-file','--state-file','--loopback','--expected-router-id','--public-origin','--output'], fn: enroll },
  import: { args: ['--install-root','--envelope'], fn: importEnvelope }
};
try {
  const command = commands[process.argv[2]];
  if (!command) fail('EXPECTED_PREPARE_ENROLL_OR_IMPORT');
  const result = await command.fn(options(process.argv.slice(3), command.args));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: error.safeCode || 'HANDOFF_OPERATION_FAILED',
    ...(typeof error.code === 'string' && /^E[A-Z0-9_]{1,64}$/.test(error.code) ? { causeCode: error.code } : {}) }));
  process.exitCode = 1;
}
