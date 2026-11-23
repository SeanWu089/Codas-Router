import { spawn } from 'node:child_process';
import path from 'node:path';
import { noLinks, RuntimeFault, settlesWithin } from './common.mjs';

export async function acquireRuntimeLease(layout, { onLost = () => {}, timeoutMs = 15000 } = {}) {
  const lockFile = path.join(layout.stateDir, 'runtime-owner.lock');
  await noLinks(lockFile, { missing: true });
  const windows = process.platform === 'win32';
  const command = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'flock';
  const argv = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(layout.runtimeDir, 'Hold-RuntimeLock.ps1'), '-LockFile', lockFile]
    : ['-n', '-E', '73', lockFile, process.execPath, path.join(layout.runtimeDir, 'lease-holder.mjs')];
  const child = spawn(command, argv, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // A concurrent helper exit can close its pipe.
  let released = false, acquired = false, exited = false, text = '';
  let rejectStart;
  const done = new Promise(resolve => {
    child.once('exit', code => {
      exited = true;
      if (!acquired) rejectStart?.(new RuntimeFault(code === 73 ? 'SUPERVISOR_ALREADY_RUNNING' : 'SUPERVISOR_LOCK_UNAVAILABLE'));
      else if (!released) onLost();
      resolve();
    });
    child.once('error', () => { exited = true; rejectStart?.(new RuntimeFault('SUPERVISOR_LOCK_UNAVAILABLE')); if (acquired && !released) onLost(); resolve(); });
  });
  // Drain diagnostics without persisting arbitrary host/PowerShell text.
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      rejectStart = reject;
      const timer = setTimeout(() => reject(new RuntimeFault('SUPERVISOR_LOCK_TIMEOUT')), timeoutMs);
      const finish = (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      child.stdout.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.length > 8192) return finish(new RuntimeFault('SUPERVISOR_LOCK_PROTOCOL_ERROR'));
        if (!text.includes('\n')) return;
        try {
          const value = JSON.parse(text.split(/\r?\n/)[0].replace(/^\uFEFF/, ''));
          if (value.acquired === true) { acquired = true; finish(); }
          else finish(new RuntimeFault(value.reason === 'LOCK_HELD' ? 'SUPERVISOR_ALREADY_RUNNING' : 'SUPERVISOR_LOCK_UNAVAILABLE'));
        } catch { finish(new RuntimeFault('SUPERVISOR_LOCK_PROTOCOL_ERROR')); }
      });
      child.once('exit', () => clearTimeout(timer)); child.once('error', () => clearTimeout(timer));
    });
  } catch (error) {
    released = true; child.stdin.end();
    await settlesWithin(done, 2000);
    if (!exited) child.kill('SIGKILL');
    throw error;
  }
  return {
    pid: child.pid,
    async release() {
      released = true;
      if (!exited) { child.stdin.write('STOP\n'); child.stdin.end(); }
      await settlesWithin(done, 5000);
      if (!exited) { child.kill('SIGKILL'); await settlesWithin(done, 2000); }
      if (!exited) throw new RuntimeFault('SUPERVISOR_LOCK_RELEASE_FAILED');
    }
  };
}
