// Standalone, hash-pinned Node helper: no dependency or unverified dynamic import.
// Node's Windows filesystem APIs support deep package paths without changing OS policy.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const required = [
  'node/node.exe', 'node/LICENSE', 'router/agent.js', 'router/agent-sse.js', 'router/package.json',
  'devspace/node_modules/@waishnav/devspace/dist/cli.js',
  'devspace/node_modules/@waishnav/devspace/package.json',
  'devspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'runtime/supervisor.mjs', 'runtime/control.mjs', 'runtime/init-state.mjs', 'runtime/probe.mjs',
];
const hex = /^[0-9a-f]{64}$/i;
function fail(message) { throw new Error(message); }
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/')) fail('Invalid relative manifest path');
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[<>"|?*\x00-\x1f]/.test(segment) || /[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('Invalid manifest path segment');
  }
  return value;
}
function contained(root, target) {
  const full = path.resolve(target);
  const rel = path.relative(path.resolve(root), full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('Path is not strictly contained');
  return full;
}
async function noLinks(target) {
  let cursor = path.resolve(target);
  for (;;) {
    try {
      const info = await fsp.lstat(cursor);
      if (info.isSymbolicLink()) fail('Reparse/symbolic link is not permitted');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function digest(filename) {
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('Expected a regular payload file');
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { sha256: hash.digest('hex'), size: info.size };
  } finally { await handle.close(); }
}
async function manifestAt(filename, pin) {
  if (!hex.test(pin || '')) fail('Pinned manifest digest is required');
  await noLinks(filename);
  if ((await digest(filename)).sha256 !== pin.toLowerCase()) fail('Manifest hash mismatch');
  const manifest = JSON.parse(await fsp.readFile(filename, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid payload manifest schema');
  const files = new Map();
  for (const file of manifest.files) {
    const name = relative(file.path);
    const key = name.toLowerCase();
    if (files.has(key)) fail('Duplicate case-insensitive manifest path');
    if (!hex.test(file.sha256 || '')) fail('Invalid file digest');
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0)) fail('Invalid file size');
    files.set(key, { ...file, sha256: file.sha256.toLowerCase() });
  }
  for (const name of required) if (!files.has(name.toLowerCase())) fail(`Required dependency absent: ${name}`);
  return files;
}
async function inParallel(values, count, fn) {
  let cursor = 0;
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(count, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length || failures.length) return;
      try { await fn(values[index]); } catch (error) { failures.push(error); }
    }
  }));
  if (failures.length) throw failures[0];
}
async function verify(root, files) {
  await noLinks(root);
  if (!(await fsp.lstat(root)).isDirectory()) fail('Payload root is not a directory');
  const queue = [path.resolve(root)];
  const observed = new Set();
  const actual = [];
  for (let i = 0; i < queue.length; i++) {
    for (const name of await fsp.readdir(queue[i])) {
      const filename = contained(root, path.join(queue[i], name));
      const info = await fsp.lstat(filename);
      if (info.isSymbolicLink()) fail('Reparse/symbolic link in payload');
      if (info.isDirectory()) { queue.push(filename); continue; }
      if (!info.isFile()) fail('Non-regular file in payload');
      const rel = path.relative(root, filename).split(path.sep).join('/');
      const key = rel.toLowerCase();
      if (!files.has(key)) fail(`Unmanifested payload file: ${rel}`);
      if (observed.has(key)) fail('Duplicate observed payload path');
      observed.add(key);
      actual.push({ filename, entry: files.get(key), rel });
    }
  }
  for (const [key, file] of files) if (!observed.has(key)) fail(`Missing payload file: ${file.path}`);
  let bytes = 0;
  await inParallel(actual, 8, async ({ filename, entry, rel }) => {
    const info = await fsp.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) fail('Payload file type changed');
    const checked = await digest(filename);
    if (checked.sha256 !== entry.sha256 || (entry.size !== undefined && checked.size !== entry.size)) fail(`Payload hash/size mismatch: ${rel}`);
    bytes += checked.size;
  });
  return { files: actual.length, bytes };
}
async function stage(source, destination, installRoot, files) {
  contained(installRoot, destination);
  const fromSource = path.relative(source, destination);
  if (!fromSource || (!fromSource.startsWith(`..${path.sep}`) && fromSource !== '..' && !path.isAbsolute(fromSource))) fail('Source and staging destination overlap');
  await noLinks(destination);
  try { if ((await fsp.readdir(destination)).length) fail('Staging target is not empty'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fsp.mkdir(destination, { recursive: true });
  await inParallel([...files.values()], 8, async entry => {
    const from = contained(source, path.join(source, ...entry.path.split('/')));
    const to = contained(destination, path.join(destination, ...entry.path.split('/')));
    await noLinks(path.dirname(to));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    const info = await fsp.lstat(from);
    if (info.isSymbolicLink() || !info.isFile()) fail('Source changed during staging');
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  });
  return verify(destination, files);
}
async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--mode','--payload-root','--manifest','--manifest-sha256','--target','--install-root'].includes(key) || value === undefined || args.has(key)) fail('Invalid helper arguments');
    args.set(key, value);
  }
  const mode = args.get('--mode');
  if (!['verify', 'stage'].includes(mode)) fail('Expected verify or stage mode');
  if (!args.get('--payload-root') || !args.get('--manifest')) fail('Payload root and manifest are required');
  const root = path.resolve(args.get('--payload-root'));
  const files = await manifestAt(args.get('--manifest'), args.get('--manifest-sha256'));
  let result = await verify(root, files);
  if (mode === 'stage') {
    if (!args.get('--target') || !args.get('--install-root')) fail('Staging target and installation root are required');
    result = await stage(root, path.resolve(args.get('--target')), path.resolve(args.get('--install-root')), files);
  }
  process.stdout.write(`${JSON.stringify({ passed: true, mode, ...result, runtimeAcceptance: false, provenanceVerified: false })}\n`);
}
main().catch(error => {
  // No file contents, environment variables, credentials, or process arguments.
  process.stderr.write(`${JSON.stringify({ passed: false, error: error.message })}\n`);
  process.exitCode = 1;
});
