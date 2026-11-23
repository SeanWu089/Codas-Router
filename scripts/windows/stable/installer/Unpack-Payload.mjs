// Standalone offline extractor. The PowerShell bootstrap pins this exact file
// and bootstrap/node.exe before execution. Only built-in Node modules are used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('CODAS-PAYLOAD-V1\n', 'ascii');
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const native = name => process.platform === 'win32' ? path.toNamespacedPath(name) : name;

function safeMember(name) {
  if (typeof name !== 'string' || !name || name !== name.normalize('NFC') || /[\\\x00-\x1f<>:"|?*]/.test(name) || name.startsWith('/')) throw new Error('Unsafe payload path');
  if (name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe payload path component');
  return name;
}

function plainAncestors(name) {
  let current = path.resolve(name);
  while (true) {
    if (fs.existsSync(native(current))) {
      const stat = fs.lstatSync(native(current));
      if (stat.isSymbolicLink()) throw new Error('Reparse/symlink path refused');
      const real = fs.realpathSync.native(native(current));
      const normalize = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase();
      if (process.platform === 'win32' && normalize(real) !== normalize(current)) throw new Error('Redirected path refused');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readRegular(name, limit = 64 * 1024 * 1024) {
  plainAncestors(name);
  const stat = fs.lstatSync(native(name));
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid package metadata file');
  return fs.readFileSync(native(name));
}

function checkedJson(name, expectedHash) {
  const bytes = readRegular(name);
  if (expectedHash && (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash)) throw new Error('Package metadata digest mismatch');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function readRange(fd, length, offset) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, bytes, read, length - read, offset + read);
    if (count === 0) throw new Error('Truncated payload archive');
    read += count;
  }
  return bytes;
}

function hashFileDescriptor(fd, size) {
  const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
  for (let offset = 0; offset < size;) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (count === 0) throw new Error('Truncated payload archive');
    digest.update(chunk.subarray(0, count)); offset += count;
  }
  return digest.digest('hex');
}

export function verifyOrExtract({ packageRoot, target, installRoot, verifyOnly = false }) {
  if (!packageRoot || (verifyOnly && target) || (!verifyOnly && (!target || !installRoot))) throw new Error('Specify --verify-only, or --target and --install-root');
  packageRoot = path.resolve(packageRoot);
  plainAncestors(packageRoot);
  const release = checkedJson(path.join(packageRoot, 'release.json'));
  const archive = release.payloadArchive;
  if (release.schemaVersion !== 1 || !archive || archive.format !== 'codas-payload-v1' || archive.path !== 'payload.codas' || archive.indexPath !== 'payload-index.json') throw new Error('Unsupported packed payload format');
  const manifest = checkedJson(path.join(packageRoot, 'payload-manifest.json'), release.manifestSha256);
  const index = checkedJson(path.join(packageRoot, archive.indexPath), archive.indexSha256);
  if (manifest.schemaVersion !== 1 || index.schemaVersion !== 1 || index.format !== archive.format || !Array.isArray(manifest.files) || !Array.isArray(index.files) || !manifest.files.length || manifest.files.length > 100_000 || manifest.files.length !== index.files.length) throw new Error('Invalid payload index or manifest');
  if (!Number.isSafeInteger(archive.size) || archive.size < MAGIC.length || archive.size > MAX_TOTAL_BYTES || !/^[a-f0-9]{64}$/.test(archive.sha256 || '')) throw new Error('Invalid archive size/digest');
  let offset = MAGIC.length, totalBytes = 0;
  const seen = new Set();
  for (let i = 0; i < manifest.files.length; i++) {
    const expected = manifest.files[i], member = index.files[i];
    safeMember(expected.path);
    if (seen.has(expected.path.toLowerCase())) throw new Error('Duplicate payload member');
    seen.add(expected.path.toLowerCase());
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) throw new Error('Invalid manifest file size/digest');
    if (member.path !== expected.path || member.sha256 !== expected.sha256 || member.size !== expected.size || member.offset !== offset || !Number.isSafeInteger(member.compressedSize) || member.compressedSize < 0 || member.compressedSize > MAX_FILE_BYTES || !['store', 'deflate-raw'].includes(member.compression)) throw new Error('Archive index does not match payload manifest');
    if (member.compression === 'store' && member.compressedSize !== member.size) throw new Error('Invalid stored member size');
    offset += member.compressedSize; totalBytes += member.size;
    if (!Number.isSafeInteger(offset) || offset > archive.size || totalBytes > MAX_TOTAL_BYTES) throw new Error('Payload archive size limit exceeded');
  }
  if (offset !== archive.size) throw new Error('Unindexed or overlapping archive bytes');
  // Reject file/directory prefix collisions before any writes.
  for (const member of manifest.files) {
    const parts = member.path.split('/'); parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/').toLowerCase())) throw new Error('Payload file/directory collision');
      parts.pop();
    }
  }
  if (!verifyOnly) {
    target = path.resolve(target); installRoot = path.resolve(installRoot);
    const relative = path.relative(installRoot, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Target must be a child of the authorized install root');
    if (path.basename(target) !== 'payload') throw new Error('Target must be the staged payload directory');
    plainAncestors(installRoot); plainAncestors(target);
    if (fs.existsSync(native(target))) {
      if (!fs.lstatSync(native(target)).isDirectory() || fs.readdirSync(native(target)).length) throw new Error('Target must be absent or empty');
    }
  }
  const archivePath = path.join(packageRoot, archive.path);
  plainAncestors(archivePath);
  const fd = fs.openSync(native(archivePath), 'r');
  try {
    const original = fs.fstatSync(fd, { bigint: true });
    if (!original.isFile() || original.nlink !== 1n || original.size !== BigInt(archive.size)) throw new Error('Archive file identity/size mismatch');
    if (!readRange(fd, MAGIC.length, 0).equals(MAGIC)) throw new Error('Invalid payload archive header');
    if (hashFileDescriptor(fd, archive.size) !== archive.sha256) throw new Error('Payload archive digest mismatch');
    if (!verifyOnly) fs.mkdirSync(native(target), { recursive: true });
    for (const member of index.files) {
      const compressed = readRange(fd, member.compressedSize, member.offset);
      const bytes = member.compression === 'store' ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: member.size + 1 });
      if (bytes.length !== member.size || hash(bytes) !== member.sha256) throw new Error(`Payload member verification failed: ${member.path}`);
      if (!verifyOnly) {
        const destination = path.join(target, ...member.path.split('/'));
        plainAncestors(destination);
        fs.mkdirSync(native(path.dirname(destination)), { recursive: true });
        fs.writeFileSync(native(destination), bytes, { flag: 'wx', mode: 0o644 });
      }
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.size !== original.size || after.mtimeNs !== original.mtimeNs || after.ctimeNs !== original.ctimeNs || after.ino !== original.ino) throw new Error('Archive changed during verification');
    return { passed: true, ok: true, mode: verifyOnly ? 'verify-only' : 'extract', files: manifest.files.length, bytes: totalBytes, manifestSha256: release.manifestSha256 };
  } finally { fs.closeSync(fd); }
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verify-only') options.verifyOnly = true;
    else if (['--package-root', '--target', '--install-root'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${arg} value`);
      options[{ '--package-root': 'packageRoot', '--target': 'target', '--install-root': 'installRoot' }[arg]] = args[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  process.stdout.write(JSON.stringify(verifyOrExtract(options)) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ passed: false, error: error.message }) + '\n'); process.exitCode = 1; }
}
