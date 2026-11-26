// Reference-only coordinator identity registry. No live Router integration.
// A binding records a trusted, independently authorized identity decision;
// neither possession of a public key nor a registry entry grants access.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { normalizeDeviceIdentity, planIdentityBinding } from './device-identity.js';

const VERSION = 1;
const APP_ID = 0x43444931; // CDI1
const MAX_BINDINGS = 10_000;
const CONSTRUCTOR = Symbol('registry constructor');
const META = 'CREATE TABLE registry_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), network_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0)) STRICT';
const BINDINGS = 'CREATE TABLE identity_bindings (route_id TEXT PRIMARY KEY NOT NULL, identity_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, bound_revision INTEGER NOT NULL UNIQUE CHECK(bound_revision > 0)) STRICT';

function invariant(ok, code) {
  if (!ok) throw new Error(code);
}
function isNetworkId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').length === 32 &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
function ownerOnly(st) {
  return st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

// POSIX local-state reference adapter. A Windows coordinator needs an
// equivalent ACL/reparse-point adapter before this is used in production.
// The database must not reside on a synced/network filesystem. Same-user
// malicious processes are not a security boundary of this adapter.
function checkedPath(filePath) {
  invariant(process.platform !== 'win32' && typeof process.getuid === 'function',
    'IDENTITY_REGISTRY_REQUIRES_PLATFORM_STORAGE');
  invariant(typeof filePath === 'string' && path.isAbsolute(filePath) &&
    !filePath.includes('\0'), 'IDENTITY_REGISTRY_PATH_INVALID');
  const parent = path.dirname(filePath);
  const directory = lstatSync(parent);
  invariant(directory.isDirectory() && !directory.isSymbolicLink() &&
    ownerOnly(directory), 'IDENTITY_REGISTRY_STORAGE_UNSAFE');
  return path.join(realpathSync(parent), path.basename(filePath));
}
function checkedFile(file, optional = false) {
  try {
    const st = lstatSync(file);
    invariant(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 &&
      ownerOnly(st), 'IDENTITY_REGISTRY_STORAGE_UNSAFE');
    return { dev: st.dev, ino: st.ino };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return false;
    throw error;
  }
}
function checkSidecars(file, creating = false) {
  const journal = checkedFile(file + '-journal', true);
  const wal = checkedFile(file + '-wal', true);
  const shm = checkedFile(file + '-shm', true);
  invariant(!wal && !shm && (!creating || !journal),
    'IDENTITY_REGISTRY_UNEXPECTED_JOURNAL');
}
function syncDirectory(file) {
  const fd = openSync(path.dirname(file), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function connect(file) {
  const db = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
    invariant(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete',
      'IDENTITY_REGISTRY_JOURNAL_MODE_INVALID');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function transaction(db, write, fn) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
function checkSchema(db) {
  invariant(db.prepare('PRAGMA application_id').get().application_id === APP_ID &&
    db.prepare('PRAGMA user_version').get().user_version === VERSION,
    'IDENTITY_REGISTRY_FORMAT_INVALID');
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  invariant(objects.length === 2 &&
    objects[0].type === 'table' && objects[0].name === 'identity_bindings' && objects[0].sql === BINDINGS &&
    objects[1].type === 'table' && objects[1].name === 'registry_meta' && objects[1].sql === META,
    'IDENTITY_REGISTRY_SCHEMA_INVALID');
}
function metadata(db, expectedNetworkId) {
  const rows = db.prepare('SELECT singleton, network_id, revision FROM registry_meta LIMIT 2').all();
  invariant(rows.length === 1 && rows[0].singleton === 1 &&
    isNetworkId(rows[0].network_id) && Number.isSafeInteger(rows[0].revision) &&
    rows[0].revision >= 0 && rows[0].revision <= MAX_BINDINGS,
    'IDENTITY_REGISTRY_METADATA_INVALID');
  invariant(rows[0].network_id === expectedNetworkId, 'IDENTITY_REGISTRY_NETWORK_MISMATCH');
  return { networkId: rows[0].network_id, revision: rows[0].revision };
}
function decodeBinding(row) {
  const identity = normalizeDeviceIdentity({
    version: VERSION, algorithm: 'P-256', identityId: row.identity_id, publicKey: row.public_key
  });
  // Reuse the existing route-id validation rule rather than inventing another.
  const record = planIdentityBinding([], row.route_id, identity)[0];
  invariant(Number.isSafeInteger(row.bound_revision) && row.bound_revision > 0 &&
    row.bound_revision <= MAX_BINDINGS, 'IDENTITY_REGISTRY_REVISION_INVALID');
  return { ...record, boundRevision: row.bound_revision };
}
function snapshot(db, expectedNetworkId) {
  const meta = metadata(db, expectedNetworkId);
  const rows = db.prepare(
    'SELECT route_id, identity_id, public_key, bound_revision FROM identity_bindings ORDER BY bound_revision LIMIT ?'
  ).all(MAX_BINDINGS + 1);
  invariant(rows.length === meta.revision, 'IDENTITY_REGISTRY_REVISION_INVALID');
  const routes = new Set(), identities = new Set();
  const bindings = rows.map((row, index) => {
    const item = decodeBinding(row);
    invariant(item.boundRevision === index + 1 && !routes.has(item.routeId) &&
      !identities.has(item.identity.identityId), 'IDENTITY_REGISTRY_BINDING_INVALID');
    routes.add(item.routeId);
    identities.add(item.identity.identityId);
    return item;
  });
  return { version: VERSION, ...meta, bindings };
}

export class IdentityRegistry {
  #db;
  #file;
  #networkId;
  #fileIdentity;
  constructor(token, db, file, networkId, fileIdentity) {
    invariant(token === CONSTRUCTOR, 'IDENTITY_REGISTRY_USE_FACTORY');
    this.#db = db;
    this.#file = file;
    this.#networkId = networkId;
    this.#fileIdentity = fileIdentity;
  }
  get networkId() { return this.#networkId; }
  #connection() {
    invariant(this.#db !== null, 'IDENTITY_REGISTRY_CLOSED');
    invariant(checkedPath(this.#file) === this.#file, 'IDENTITY_REGISTRY_STORAGE_UNSAFE');
    const current = checkedFile(this.#file);
    invariant(current.dev === this.#fileIdentity.dev && current.ino === this.#fileIdentity.ino,
      'IDENTITY_REGISTRY_FILE_REPLACED');
    checkSidecars(this.#file);
    return this.#db;
  }
  snapshot() {
    const db = this.#connection();
    return transaction(db, false, () => {
      checkSchema(db);
      return snapshot(db, this.#networkId);
    });
  }

  // TRUSTED internal persistence primitive, NOT a public enrollment method.
  // A future migration service must authenticate the existing grant, verify
  // proof of the new key, and serialize grant revalidation + binding in one
  // coordinator transaction. This API deliberately cannot modify grants.
  recordTrustedBinding(routeId, identity) {
    const canonical = normalizeDeviceIdentity(identity);
    planIdentityBinding([], routeId, canonical);
    const db = this.#connection();
    return transaction(db, true, () => {
      checkSchema(db);
      const meta = metadata(db, this.#networkId);
      const range = db.prepare('SELECT count(*) AS count, min(bound_revision) AS first, max(bound_revision) AS last FROM identity_bindings').get();
      invariant(range.count === meta.revision && (range.count === 0 ||
        (range.first === 1 && range.last === meta.revision)), 'IDENTITY_REGISTRY_REVISION_INVALID');
      const rows = db.prepare(
        'SELECT route_id, identity_id, public_key, bound_revision FROM identity_bindings WHERE route_id = ? OR identity_id = ?'
      ).all(routeId, canonical.identityId);
      if (rows.length) {
        invariant(rows.length === 1 && rows[0].route_id === routeId &&
          rows[0].identity_id === canonical.identityId &&
          rows[0].public_key === canonical.publicKey,
          'IDENTITY_BINDING_COLLISION');
        const binding = decodeBinding(rows[0]);
        invariant(binding.boundRevision <= meta.revision, 'IDENTITY_REGISTRY_REVISION_INVALID');
        return { created: false, revision: meta.revision, binding };
      }
      invariant(meta.revision < MAX_BINDINGS, 'IDENTITY_REGISTRY_CAPACITY');
      const next = meta.revision + 1;
      db.prepare('INSERT INTO identity_bindings(route_id, identity_id, public_key, bound_revision) VALUES (?, ?, ?, ?)')
        .run(routeId, canonical.identityId, canonical.publicKey, next);
      const changed = db.prepare('UPDATE registry_meta SET revision = ? WHERE singleton = 1 AND revision = ?')
        .run(next, meta.revision);
      invariant(changed.changes === 1, 'IDENTITY_REGISTRY_REVISION_INVALID');
      return { created: true, revision: next,
        binding: { routeId, identity: canonical, boundRevision: next } };
    });
  }
  close() {
    if (this.#db !== null) {
      this.#db.close();
      this.#db = null;
    }
  }
}

// Explicit, one-time initialization. The exclusive file reservation means
// concurrent initialization cannot overwrite another network. A crash before
// initialization commits may leave an incomplete file; opening it fails
// closed and requires explicit operator recovery, never automatic recreation.
export function initializeIdentityRegistry(filePath) {
  const file = checkedPath(filePath);
  function alreadyExists() {
    const error = new Error('IDENTITY_REGISTRY_ALREADY_EXISTS');
    error.code = 'EEXIST';
    throw error;
  }
  if (checkedFile(file, true)) alreadyExists();
  try { checkSidecars(file, true); }
  catch (error) {
    if (checkedFile(file, true)) alreadyExists();
    throw error;
  }
  const fd = openSync(file, 'wx', 0o600);
  closeSync(fd);
  const networkId = randomBytes(32).toString('base64url');
  let db;
  try {
    db = connect(file);
    transaction(db, true, () => {
      db.exec('PRAGMA application_id = ' + APP_ID + '; PRAGMA user_version = ' + VERSION + ';');
      db.exec(META);
      db.exec(BINDINGS);
      db.prepare('INSERT INTO registry_meta(singleton, network_id, revision) VALUES (1, ?, 0)').run(networkId);
    });
  } finally { if (db) db.close(); }
  syncDirectory(file);
  return openIdentityRegistry(file, networkId);
}

// Loading is intentionally separate from initialization. The caller must know
// the expected network from trusted configuration or an approved transfer.
// Missing, corrupt, wrong-network and incomplete state cannot mint a new ID.
export function openIdentityRegistry(filePath, expectedNetworkId) {
  invariant(isNetworkId(expectedNetworkId), 'IDENTITY_REGISTRY_EXPECTED_NETWORK_REQUIRED');
  const file = checkedPath(filePath);
  const fileIdentity = checkedFile(file);
  checkSidecars(file);
  const db = connect(file);
  try {
    transaction(db, false, () => {
      checkSchema(db);
      const integrity = db.prepare('PRAGMA integrity_check(1)').get();
      invariant(integrity?.integrity_check === 'ok', 'IDENTITY_REGISTRY_INTEGRITY_FAILED');
      snapshot(db, expectedNetworkId);
    });
    const current = checkedFile(file);
    invariant(current.dev === fileIdentity.dev && current.ino === fileIdentity.ino,
      'IDENTITY_REGISTRY_FILE_REPLACED');
    return new IdentityRegistry(CONSTRUCTOR, db, file, expectedNetworkId, fileIdentity);
  } catch (error) {
    db.close();
    throw error;
  }
}
