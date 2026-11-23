import { promises as fs } from 'node:fs';
import path from 'node:path';
import { noLinks } from './common.mjs';

// Logs contain only caller-selected structured fields, never child text, tokens,
// HTTP bodies, process environments or command output. Two bounded files remain.
export async function createLogger(directory, { maxBytes = 1024 * 1024 } = {}) {
  await noLinks(directory, { missing: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'runtime.jsonl'), previous = `${file}.previous`;
  let chain = Promise.resolve();
  return async (event, evidence = {}) => {
    const record = JSON.stringify({ at: new Date().toISOString(), event, ...evidence }) + '\n';
    if (Buffer.byteLength(record) > 8192) throw new Error('Runtime log record exceeds bound');
    chain = chain.then(async () => {
      await noLinks(file, { missing: true });
      await noLinks(previous, { missing: true });
      const size = await fs.stat(file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size + Buffer.byteLength(record) > maxBytes) {
        await fs.rm(previous, { force: true });
        await fs.rename(file, previous).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await fs.appendFile(file, record, { mode: 0o600 });
    });
    return chain;
  };
}
