import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { atomicJson } from '../scripts/windows/stable/runtime/common.mjs';

const actualPlatform = process.platform;
const refusal = (code, syscall = 'rename') => Object.assign(new Error('fixture refusal'), { code, syscall });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codas-atomic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }));
  const file = path.join(directory, 'state.json');
  const old = '{"identity":"preserved","generation":41}\n';
  await fs.writeFile(file, old);
  return { directory, file, old, next: { identity: 'preserved', generation: 42 } };
}
async function onPlatform(platform, operation) {
  // Exercise the policy on every CI host without changing the native fs/path
  // implementation. Top-level tests in this file are explicitly sequential.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return await operation(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}

test('Windows atomic state replacement retries transient refusals using one flushed temporary file', { concurrency: false }, async t => {
  const f = await fixture(t), rename = fs.rename;
  const sources = [], codes = ['EPERM', 'EACCES', 'EBUSY'];
  t.mock.method(fs, 'rename', async (source, destination) => {
    assert.equal(destination, f.file);
    sources.push(source);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
    assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), f.next);
    if (sources.length <= codes.length) throw refusal(codes[sources.length - 1]);
    return rename(source, destination);
  });
  await onPlatform('win32', () => atomicJson(f.file, f.next));
  assert.equal(sources.length, 4);
  assert.equal(new Set(sources).size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.next);
  assert.deepEqual(await fs.readdir(f.directory), ['state.json']);
});

test('permanent Windows rename refusal stays bounded and preserves the old JSON and first error', { concurrency: false, timeout: 10000 }, async t => {
  const f = await fixture(t), first = refusal('EPERM');
  let calls = 0;
  t.mock.method(fs, 'rename', async () => {
    assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
    calls++;
    throw calls === 1 ? first : refusal('EPERM');
  });
  await onPlatform('win32', () => assert.rejects(atomicJson(f.file, f.next), error => error === first));
  assert.ok(calls > 1 && calls <= 16);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
  assert.deepEqual(await fs.readdir(f.directory), ['state.json']);
});

for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EACCES'], ['win32', 'EIO'], ['win32', 'ENOSPC']]) {
  test(`${platform} ${code} outside the retry policy fails after one atomic replacement attempt`, { concurrency: false }, async t => {
    const f = await fixture(t), error = refusal(code);
    let calls = 0;
    t.mock.method(fs, 'rename', async () => { calls++; throw error; });
    await onPlatform(platform, () => assert.rejects(atomicJson(f.file, f.next), actual => actual === error));
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
    assert.deepEqual(await fs.readdir(f.directory), ['state.json']);
  });
}

test('an exclusive state creation never replaces an existing identity or retries a link failure', { concurrency: false }, async t => {
  const f = await fixture(t), link = fs.link;
  let links = 0;
  t.mock.method(fs, 'link', async (...args) => { links++; return link(...args); });
  t.mock.method(fs, 'rename', () => assert.fail('Exclusive creation must not replace a file'));
  await onPlatform('win32', () => assert.rejects(atomicJson(f.file, f.next, { exclusive: true }), { code: 'EEXIST' }));
  assert.equal(links, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
});

for (const failingOperation of ['writeFile', 'sync']) {
  test(`atomic ${failingOperation} failure survives later close and temporary-cleanup errors`, { concurrency: false }, async t => {
    const f = await fixture(t), open = fs.open, remove = fs.rm;
    const primary = refusal('EIO', failingOperation === 'sync' ? 'fsync' : 'write');
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      return {
        async writeFile(...values) { await handle.writeFile(...values); if (failingOperation === 'writeFile') throw primary; },
        async sync() { await handle.sync(); if (failingOperation === 'sync') throw primary; },
        async close() { await handle.close(); throw refusal('EBADF', 'close'); }
      };
    });
    t.mock.method(fs, 'rm', (file, options) => file.endsWith('.tmp') ? Promise.reject(refusal('EPERM', 'unlink')) : remove(file, options));
    t.mock.method(fs, 'rename', () => assert.fail('An unflushed or unclosed file must not be published'));
    await assert.rejects(atomicJson(f.file, f.next), error => error === primary);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
  });
}

test('rename failure survives a failed temporary cleanup without deleting the destination', { concurrency: false }, async t => {
  const f = await fixture(t), remove = fs.rm, primary = refusal('EIO');
  const removed = [];
  t.mock.method(fs, 'rename', async () => { throw primary; });
  t.mock.method(fs, 'rm', (file, options) => {
    removed.push(file);
    if (file.endsWith('.tmp')) throw refusal('EPERM', 'unlink');
    return remove(file, options);
  });
  await assert.rejects(atomicJson(f.file, f.next), error => error === primary);
  assert.equal(removed.length, 1); assert.notEqual(removed[0], f.file);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
});

test('native Windows FileShare.Read refusal recovers after the real reader releases its handle', { concurrency: false, skip: actualPlatform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t);
  const script = path.join(f.directory, 'hold-reader.ps1');
  await fs.writeFile(script, `param([string]$Target)
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  $stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally { if ($null -ne $stream) { $stream.Dispose() } }
`);
  const child = spawn(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Target', f.file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let timer;
  const boundedExit = () => Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned reader did not exit')), 5000); })]).finally(() => clearTimeout(timer));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Owned reader did not acquire its handle')), 15000);
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('LOCKED')) { clearTimeout(timeout); resolve(); } });
      done.then(() => { clearTimeout(timeout); reject(new Error('Owned reader exited before its handshake')); }, error => { clearTimeout(timeout); reject(error); });
    });
    const rename = fs.rename, observed = [];
    let releaseRequested = false;
    t.mock.method(fs, 'rename', async (source, destination) => {
      try { return await rename(source, destination); }
      catch (error) {
        observed.push(error.code);
        assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
        assert.equal(await fs.readFile(f.file, 'utf8'), f.old);
        if (!releaseRequested) { releaseRequested = true; child.stdin.end('\n'); }
        throw error;
      }
    });
    await atomicJson(f.file, f.next);
    assert.ok(observed.length >= 1);
    assert.equal(await boundedExit(), 0);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.next);
  } finally {
    child.stdin.end('\n');
    if (child.exitCode === null && child.signalCode === null) {
      try { await boundedExit(); }
      catch { child.kill('SIGKILL'); await done; }
    }
  }
});
