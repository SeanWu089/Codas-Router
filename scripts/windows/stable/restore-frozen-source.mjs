// Restore the two original transport commits from a pinned local Git bundle.
// No network, checkout, source edits, branch updates, or configurable ref names.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FROZEN_REVISION = 'c1497cac73c8d147dfcd74127018be470ae8a72a';
export const FROZEN_TREE = '120b181e4a13069f1c40058cde139f6844504f29';
export const PREREQUISITE_REVISION = '0961b97ed8d2393f0aab57aa38593dc9968553b3';
export const FROZEN_REF = 'refs/codas/frozen-windows-transport';
export const BUNDLE_SHA256 = '92daeff1621cfa639961864a75d4e230f4e50781d0550c5a680447a0f70f1c66';
const commits = [
  { commit: 'f8b3130988bfb9fa44bd456db31954a3835ebcb6', parent: PREREQUISITE_REVISION, tree: '03faf388bca591bd2f18e1189e1f4d64c4a5fa92' },
  { commit: FROZEN_REVISION, parent: 'f8b3130988bfb9fa44bd456db31954a3835ebcb6', tree: FROZEN_TREE },
];
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
function git(root, args, { allowMissing = false, message } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
  if (allowMissing && result.status === 1) return null;
  if (result.error || result.status !== 0) throw new Error(message || `Git ${args[0]} failed while restoring frozen source.`);
  return result.stdout.trim();
}
function regularBytes(filename, maximum) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new Error('Frozen source inputs must be bounded regular files.');
  return fs.readFileSync(filename);
}

export function restoreFrozenSource({ root = repositoryRoot } = {}) {
  root = path.resolve(root);
  const pins = JSON.parse(regularBytes(path.join(root, 'dependencies/windows-frozen-transport.json'), 16 * 1024).toString('utf8'));
  if (pins.schemaVersion !== 1 || pins.bundleFile !== 'windows-frozen-transport.bundle' || pins.bundleSha256 !== BUNDLE_SHA256 || pins.headRef !== FROZEN_REF || pins.headCommit !== FROZEN_REVISION || pins.headTree !== FROZEN_TREE || pins.prerequisiteCommit !== PREREQUISITE_REVISION || JSON.stringify(pins.commits) !== JSON.stringify(commits)) throw new Error('Frozen source provenance pins differ from the reviewed commits.');
  const bundle = path.join(root, 'dependencies/windows-frozen-transport.bundle');
  const bytes = regularBytes(bundle, 1024 * 1024);
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== BUNDLE_SHA256) throw new Error('Frozen source bundle SHA-256 mismatch; no objects imported.');
  const headerEnd = bytes.indexOf(Buffer.from('\n\n'));
  if (headerEnd < 0 || headerEnd > 4096) throw new Error('Invalid frozen source bundle header.');
  const header = bytes.subarray(0, headerEnd).toString('utf8').split('\n');
  if (header.length !== 3 || header[0] !== '# v2 git bundle' || !header[1].startsWith(`-${PREREQUISITE_REVISION} `) || header[2] !== `${FROZEN_REVISION} ${FROZEN_REF}`) throw new Error('Frozen source bundle contains unexpected prerequisites or refs.');
  git(root, ['bundle', 'verify', bundle], { message: `Frozen source prerequisite verification failed; full Git history containing ${PREREQUISITE_REVISION} is required.` });
  if (git(root, ['bundle', 'list-heads', bundle]) !== `${FROZEN_REVISION} ${FROZEN_REF}`) throw new Error('Frozen source bundle advertises an unexpected ref.');
  const existing = git(root, ['rev-parse', '--verify', '--quiet', FROZEN_REF], { allowMissing: true });
  if (existing !== null && existing !== FROZEN_REVISION) throw new Error('The existing frozen source ref differs; refusing to overwrite it.');
  // The only refspec is fixed. Do not write FETCH_HEAD, import tags, force refs,
  // or run automatic maintenance during this narrowly scoped local import.
  git(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', bundle, `${FROZEN_REF}:${FROZEN_REF}`]);
  if (git(root, ['rev-parse', '--verify', FROZEN_REF]) !== FROZEN_REVISION || git(root, ['rev-parse', `${FROZEN_REVISION}^{tree}`]) !== FROZEN_TREE) throw new Error('Restored frozen transport revision/tree mismatch.');
  const restored = git(root, ['rev-list', '--reverse', FROZEN_REVISION, `^${PREREQUISITE_REVISION}`]).split('\n');
  if (JSON.stringify(restored) !== JSON.stringify(commits.map(item => item.commit))) throw new Error('Restored bundle history contains unexpected commits.');
  for (const item of commits) {
    if (git(root, ['show', '-s', '--format=%H %T %P', item.commit]) !== `${item.commit} ${item.tree} ${item.parent}`) throw new Error('An original frozen commit tree or parent differs.');
  }
  return { verified: true, ref: FROZEN_REF, revision: FROZEN_REVISION, tree: FROZEN_TREE, prerequisite: PREREQUISITE_REVISION, bundleSha256: actualHash, originalCommits: commits.length, sourceFilesModified: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/windows/stable/restore-frozen-source.mjs');
    process.stdout.write(JSON.stringify(restoreFrozenSource()) + '\n');
  } catch (error) {
    process.stderr.write(`Frozen source restore refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
