// Runs only under the verified bundled Windows Node. No lifecycle scripts,
// provider login, shell child, or external service is used by this probe.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

let component = 'node';
try {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v22.23.3' || process.versions.modules !== '127') throw Object.assign(new Error(), { code: 'WRONG_BUNDLED_NODE' });
  const payload = fs.realpathSync.native(process.argv[2]);
  const requirePayload = createRequire(path.join(payload, 'devspace', 'package.json'));
  component = 'better-sqlite3';
  const Database = requirePayload('better-sqlite3');
  const database = new Database(':memory:');
  try {
    if (database.prepare('SELECT 42 AS value').get().value !== 42) throw Object.assign(new Error(), { code: 'SQLITE_RESULT_MISMATCH' });
  } finally { database.close(); }
  component = 'node-pty';
  const pty = requirePayload('node-pty');
  if (typeof pty.spawn !== 'function') throw Object.assign(new Error(), { code: 'PTY_API_MISSING' });
  // Loading the actual prebuilt addons checks ABI/DLL compatibility without
  // leaving a terminal helper behind; the later real MCP probe runs hostname.
  for (const name of ['conpty', 'pty', 'conpty_console_list']) {
    component = 'node-pty/' + name;
    const addon = require(path.join(payload, 'devspace', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', name + '.node'));
    if (!addon || !Object.keys(addon).length) throw Object.assign(new Error(), { code: 'PTY_NATIVE_EXPORTS_MISSING' });
  }
  component = 'koffi';
  const koffi = requirePayload('koffi');
  const kernel = koffi.load('kernel32.dll');
  try {
    const ownPid = kernel.func('uint32_t __stdcall GetCurrentProcessId()');
    if (ownPid() !== process.pid) throw Object.assign(new Error(), { code: 'KOFFI_RESULT_MISMATCH' });
  } finally { kernel.unload(); }
  process.stdout.write(JSON.stringify({ passed: true, node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, sqliteQueryPassed: true, ptyNativeAddonsLoaded: 3, koffiOwnProcessQueryPassed: true }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ passed: false, component, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error && error.code || '') ? error.code : 'NATIVE_MODULE_PROBE_FAILED' }) + '\n');
  process.exitCode = 1;
}
