// Identity V1 reference primitives. NOT an authentication/authorization endpoint.
// Importing this module has no side effects; no existing device state is changed.
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, sign, verify
} from 'node:crypto';
import { constants as fs } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const ALGORITHM = 'P-256';
const PREFIX = 'codas-id-v1:';
const TTL_MS = 60_000;
const MAX_PENDING = 256;

function requireCondition(ok, code) {
  if (!ok) throw new Error(code);
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
}

function decode(value, min, max) {
  requireCondition(typeof value === 'string' && value.length <= Math.ceil(max * 4 / 3) &&
    /^[A-Za-z0-9_-]+$/.test(value), 'IDENTITY_ENCODING_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  requireCondition(bytes.length >= min && bytes.length <= max &&
    bytes.toString('base64url') === value, 'IDENTITY_ENCODING_INVALID');
  return bytes;
}

function requireP256(key, type) {
  requireCondition(key.type === type && key.asymmetricKeyType === 'ec' &&
    key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'IDENTITY_KEY_INVALID');
  return key;
}

function describeKey(key) {
  const spki = requireP256(key, 'public').export({ type: 'spki', format: 'der' });
  return Object.freeze({
    version: VERSION,
    algorithm: ALGORITHM,
    identityId: PREFIX + createHash('sha256').update(spki).digest('base64url'),
    publicKey: spki.toString('base64url')
  });
}

export function normalizeDeviceIdentity(value) {
  requireCondition(exactFields(value, ['version','algorithm','identityId','publicKey']) &&
    value.version === VERSION && value.algorithm === ALGORITHM, 'IDENTITY_FORMAT_INVALID');
  const bytes = decode(value.publicKey, 91, 91);
  const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  const canonical = describeKey(key);
  requireCondition(canonical.publicKey === value.publicKey &&
    canonical.identityId === value.identityId, 'IDENTITY_FINGERPRINT_MISMATCH');
  return canonical;
}

function networkId(value) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value),
    'IDENTITY_NETWORK_INVALID');
  return value;
}

function challengeBytes(challenge) {
  requireCondition(exactFields(challenge, [
    'version','purpose','networkId','identityId','challengeId','nonce','issuedAt','expiresAt'
  ]) && challenge.version === VERSION && challenge.purpose === 'device-identity-proof',
    'IDENTITY_CHALLENGE_INVALID');
  networkId(challenge.networkId);
  requireCondition(typeof challenge.identityId === 'string' &&
    challenge.identityId.startsWith(PREFIX), 'IDENTITY_CHALLENGE_INVALID');
  decode(challenge.identityId.slice(PREFIX.length),32,32);
  decode(challenge.challengeId,16,16);
  decode(challenge.nonce,32,32);
  requireCondition(Number.isSafeInteger(challenge.issuedAt) && challenge.issuedAt >= 0 &&
    Number.isSafeInteger(challenge.expiresAt) &&
    challenge.expiresAt - challenge.issuedAt === TTL_MS, 'IDENTITY_CHALLENGE_INVALID');
  // Exact canonical UTF-8 bytes: ASCII identifiers and safe integer times.
  // Array order is normative; DER ECDSA signature, SHA-256. No arbitrary signing API.
  return Buffer.from(JSON.stringify([
    'codas/device-identity-proof/v1', challenge.networkId, challenge.identityId,
    challenge.challengeId, challenge.nonce, challenge.issuedAt, challenge.expiresAt
  ]), 'utf8');
}

function identityActor(privateKey) {
  requireP256(privateKey, 'private');
  const identity = describeKey(createPublicKey(privateKey));
  return Object.freeze({
    identity,
    prove(challenge, expectedNetworkId) {
      const bytes = challengeBytes(challenge);
      requireCondition(challenge.networkId === networkId(expectedNetworkId) &&
        challenge.identityId === identity.identityId, 'IDENTITY_CHALLENGE_SCOPE_MISMATCH');
      return Object.freeze({
        identityId: identity.identityId,
        challengeId: challenge.challengeId,
        signature: sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }).toString('base64url')
      });
    }
  });
}

function newPrivateKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

// Key generation for ephemeral tests; production clients use platform key stores.
export function generateDeviceIdentity() {
  return identityActor(newPrivateKey());
}

// Restricted local POSIX reference storage, not a cross-platform secure keystore.
// Creation is explicit, exclusive, and never an automatic fallback from load().
async function checkedIdentityDirectory(file, create = false) {
  requireCondition(process.platform !== 'win32' && typeof process.getuid === 'function',
    'IDENTITY_STORAGE_REQUIRES_PLATFORM_KEYSTORE');
  requireCondition(typeof file === 'string' && path.isAbsolute(file),
    'IDENTITY_STORAGE_PATH_INVALID');
  const directory = path.dirname(file);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await lstat(directory);
  requireCondition(st.isDirectory() && !st.isSymbolicLink() &&
    st.uid === process.getuid() && (st.mode & 0o077) === 0, 'IDENTITY_STORAGE_UNSAFE');
}

export async function createIdentityFile(file) {
  await checkedIdentityDirectory(file, true);
  const key = newPrivateKey();
  const actor = identityActor(key);
  const temp = path.join(path.dirname(file), '.identity-new-' + randomBytes(16).toString('hex'));
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({
      version: VERSION, identity: actor.identity,
      privateKey: key.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
    }) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Exclusive atomic publication: existing identity is never overwritten.
    await link(temp, file);
  } finally {
    if (handle) await handle.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return actor;
}

export async function loadIdentityFile(file) {
  await checkedIdentityDirectory(file);
  requireCondition(typeof fs.O_NOFOLLOW === 'number', 'IDENTITY_STORAGE_NOFOLLOW_UNAVAILABLE');
  const handle = await open(file, fs.O_RDONLY | fs.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    requireCondition(st.isFile() && st.uid === process.getuid() &&
      st.nlink === 1 && (st.mode & 0o077) === 0 && st.size > 0 && st.size <= 4096,
      'IDENTITY_STORAGE_UNSAFE');
    const record = JSON.parse(await handle.readFile('utf8'));
    requireCondition(exactFields(record, ['version','identity','privateKey']) &&
      record.version === VERSION, 'IDENTITY_STORAGE_INVALID');
    const bytes = decode(record.privateKey, 64, 256);
    const key = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' });
    const actor = identityActor(key);
    const persisted = normalizeDeviceIdentity(record.identity);
    requireCondition(actor.identity.identityId === persisted.identityId,
      'IDENTITY_STORAGE_KEY_MISMATCH');
    return actor;
  } finally {
    await handle.close();
  }
}

// Server-side in-memory challenge book. Successful proofs are consumed
// synchronously. Restart discards pending challenges. Proof is not permission.
export class IdentityChallenges {
  #networkId;
  #clock;
  #pending = new Map();
  constructor(id, { clock = Date.now } = {}) {
    this.#networkId = networkId(id);
    requireCondition(typeof clock === 'function', 'IDENTITY_CLOCK_INVALID');
    this.#clock = clock;
  }
  #now() {
    const now = this.#clock();
    requireCondition(Number.isSafeInteger(now) && now >= 0 &&
      now <= Number.MAX_SAFE_INTEGER - TTL_MS, 'IDENTITY_CLOCK_INVALID');
    return now;
  }
  #prune(now) {
    for (const [id, pending] of this.#pending) {
      if (now >= pending.challenge.expiresAt || now < pending.challenge.issuedAt)
        this.#pending.delete(id);
    }
  }
  issue(identity) {
    const canonical = normalizeDeviceIdentity(identity);
    const now = this.#now();
    this.#prune(now);
    requireCondition(this.#pending.size < MAX_PENDING, 'IDENTITY_CHALLENGE_LIMIT');
    let challengeId;
    do { challengeId = randomBytes(16).toString('base64url'); }
    while (this.#pending.has(challengeId));
    const challenge = Object.freeze({
      version: VERSION, purpose: 'device-identity-proof',
      networkId: this.#networkId, identityId: canonical.identityId,
      challengeId, nonce: randomBytes(32).toString('base64url'),
      issuedAt: now, expiresAt: now + TTL_MS
    });
    this.#pending.set(challengeId, { identity: canonical, challenge });
    return challenge;
  }
  verify(proof) {
    const now = this.#now();
    this.#prune(now);
    try {
      requireCondition(exactFields(proof, ['identityId','challengeId','signature']),
        'IDENTITY_PROOF_INVALID');
      decode(proof.challengeId,16,16);
      const pending = this.#pending.get(proof.challengeId);
      if (!pending || proof.identityId !== pending.identity.identityId) return null;
      const signature = decode(proof.signature,8,72);
      const key = createPublicKey({
        key: decode(pending.identity.publicKey,91,91), type: 'spki', format: 'der'
      });
      if (!verify('sha256', challengeBytes(pending.challenge),
        { key, dsaEncoding: 'der' }, signature)) return null;
      this.#pending.delete(proof.challengeId);
      return pending.identity;
    } catch {
      return null;
    }
  }
}

// Pure planning helper for TRUSTED coordinator state. The caller must already
// have independently authorized initial binding/migration; this function is
// not an enrollment endpoint and does not establish authorization.
export function planIdentityBinding(records, routeId, identity) {
  const validRouteId = value => typeof value === 'string' && value.length > 0 &&
    value.length <= 128 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  requireCondition(Array.isArray(records) && validRouteId(routeId),
    'IDENTITY_BINDING_INVALID');
  const routes = new Set();
  const identities = new Set();
  const canonical = normalizeDeviceIdentity(identity);
  const result = records.map(record => {
    requireCondition(exactFields(record, ['routeId','identity']) && validRouteId(record.routeId),
      'IDENTITY_BINDING_INVALID');
    const descriptor = normalizeDeviceIdentity(record.identity);
    requireCondition(!routes.has(record.routeId) && !identities.has(descriptor.identityId),
      'IDENTITY_BINDING_COLLISION');
    routes.add(record.routeId);
    identities.add(descriptor.identityId);
    return { routeId: record.routeId, identity: descriptor };
  });
  const byRoute = result.find(record => record.routeId === routeId);
  if (byRoute) {
    requireCondition(byRoute.identity.identityId === canonical.identityId,
      'IDENTITY_BINDING_COLLISION');
    return result;
  }
  requireCondition(!identities.has(canonical.identityId), 'IDENTITY_BINDING_COLLISION');
  return [...result, { routeId, identity: canonical }];
}
