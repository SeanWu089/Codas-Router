// Shared local POSIX SQLite reference storage. No production integration.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function invariant(ok, code) {
  if (!ok) throw new Error(code);
}
export function isNetworkId(value) {
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
export function checkedPath(filePath) {
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
export function checkedFile(file, optional = false) {
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
export function checkSidecars(file, creating = false) {
  const journal = checkedFile(file + '-journal', true);
  const wal = checkedFile(file + '-wal', true);
  const shm = checkedFile(file + '-shm', true);
  invariant(!wal && !shm && (!creating || !journal),
    'IDENTITY_REGISTRY_UNEXPECTED_JOURNAL');
}
export function syncDirectory(file) {
  const fd = openSync(path.dirname(file), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function connect(file) {
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
export function transaction(db, write, fn) {
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
