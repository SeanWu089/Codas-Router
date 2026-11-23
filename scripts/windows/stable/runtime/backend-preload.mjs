// Adapter around the unmodified published CLI. IPC permits graceful shutdown
// on Windows where ChildProcess.kill('SIGTERM') forcibly terminates Node.
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { reserveSessionRange, installSessionRange } from './session-generations.mjs';

let stopping = false;
const sendParent = message => { if (process.connected) process.send(message, () => {}); };
const stop = () => {
  if (stopping) return;
  stopping = true;
  const request = () => {
    if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
    else process.exit(0);
  };
  setImmediate(request);
};
process.on('message', message => { if (message?.type === 'stop') stop(); });
process.once('disconnect', stop);
// Report a listener created by THIS child, so a preexisting foreign service's
// successful /healthz cannot be mistaken for the backend we just launched.
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...arguments_) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && address.address === '127.0.0.1' && address.port === Number(process.env.CODAS_WINDOWS_BACKEND_PORT)) {
      sendParent({ type: 'backend-listening', port: address.port });
    }
  });
  return listen.apply(this, arguments_);
};
try {
  if (!process.env.CODAS_WINDOWS_STATE_DIR || !process.env.CODAS_WINDOWS_PAYLOAD_ROOT) throw new Error('Missing explicit installation directories');
  const modulePath = path.join(process.env.CODAS_WINDOWS_PAYLOAD_ROOT, 'devspace', 'node_modules', '@waishnav', 'devspace', 'dist', 'process-sessions.js');
  const { ProcessSessionManager } = await import(pathToFileURL(modulePath).href);
  const range = reserveSessionRange(process.env.CODAS_WINDOWS_STATE_DIR);
  installSessionRange(ProcessSessionManager, range);
} catch {
  sendParent({ type: 'terminal', code: 'SESSION_GENERATION_INITIALIZATION_FAILED' });
  process.exitCode = 78;
  // Do not let the CLI continue with unreserved process-session identifiers.
  process.exit(78);
}
