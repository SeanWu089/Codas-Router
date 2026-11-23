import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restoreFrozenSource, FROZEN_REVISION, FROZEN_TREE, PREREQUISITE_REVISION, FROZEN_REF } from '../scripts/windows/stable/restore-frozen-source.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const hasObject = (root, revision) => spawnSync('git', ['cat-file', '-e', revision], { cwd: root, stdio: 'ignore', windowsHide: true }).status === 0;
function fixture(t, { prerequisite = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codas-frozen-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  git(root, ['init', '--quiet']);
  if (prerequisite) {
    git(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', sourceRoot, `${PREREQUISITE_REVISION}:refs/heads/fixture-base`]);
    git(root, ['checkout', '--detach', PREREQUISITE_REVISION]);
  }
  fs.mkdirSync(path.join(root, 'dependencies'), { recursive: true });
  for (const name of ['windows-frozen-transport.bundle', 'windows-frozen-transport.json']) fs.copyFileSync(path.join(sourceRoot, 'dependencies', name), path.join(root, 'dependencies', name));
  assert.equal(hasObject(root, FROZEN_REVISION), false, 'Fixture must not already contain the frozen commit');
  return root;
}
function sourceBytes(root) {
  return git(root, ['ls-files', 'src']).split('\n').filter(Boolean).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]);
}

test('pinned bundle restores original commits in an isolated base clone without changing HEAD, index, sources or unrelated refs', t => {
  const root = fixture(t);
  const before = { head: git(root, ['rev-parse', 'HEAD']), index: git(root, ['ls-files', '--stage']), status: git(root, ['status', '--porcelain', '--untracked-files=all']), sources: sourceBytes(root) };
  const result = restoreFrozenSource({ root });
  assert.equal(result.verified, true);
  assert.equal(result.originalCommits, 2);
  assert.equal(git(root, ['rev-parse', `${FROZEN_REVISION}^{tree}`]), FROZEN_TREE);
  for (const revision of ['f8b3130988bfb9fa44bd456db31954a3835ebcb6', FROZEN_REVISION]) assert.equal(git(root, ['cat-file', 'commit', revision]), git(sourceRoot, ['cat-file', 'commit', revision]), 'Original commit metadata and timestamps must remain byte-identical');
  assert.deepEqual({ head: git(root, ['rev-parse', 'HEAD']), index: git(root, ['ls-files', '--stage']), status: git(root, ['status', '--porcelain', '--untracked-files=all']), sources: sourceBytes(root) }, before);
  assert.deepEqual(git(root, ['for-each-ref', '--format=%(refname)']).split('\n').sort(), [FROZEN_REF, 'refs/heads/fixture-base'].sort());
  assert.equal(fs.existsSync(path.join(root, '.git/FETCH_HEAD')), false);
  assert.deepEqual(restoreFrozenSource({ root }), result);
});

test('a tampered bundle is rejected before importing any frozen commit or ref', t => {
  const root = fixture(t);
  const filename = path.join(root, 'dependencies/windows-frozen-transport.bundle');
  const bytes = fs.readFileSync(filename); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(filename, bytes);
  assert.throws(() => restoreFrozenSource({ root }), /SHA-256 mismatch/);
  assert.equal(hasObject(root, FROZEN_REVISION), false);
  assert.equal(git(root, ['for-each-ref', '--format=%(refname)', FROZEN_REF]), '');
});

test('missing public prerequisite is rejected without an import', t => {
  const root = fixture(t, { prerequisite: false });
  assert.throws(() => restoreFrozenSource({ root }), /prerequisite verification failed/);
  assert.equal(hasObject(root, FROZEN_REVISION), false);
  assert.equal(git(root, ['for-each-ref', '--format=%(refname)']), '');
});

test('a conflicting existing frozen ref is preserved and rejected', t => {
  const root = fixture(t);
  git(root, ['update-ref', FROZEN_REF, PREREQUISITE_REVISION]);
  assert.throws(() => restoreFrozenSource({ root }), /ref differs/);
  assert.equal(git(root, ['rev-parse', FROZEN_REF]), PREREQUISITE_REVISION);
  assert.equal(hasObject(root, FROZEN_REVISION), false);
});
