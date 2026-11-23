import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TAG, PACKAGE_NAME, VERSION, TRANSPORT, draftNotes, githubApi, prepareAssets, publishDraft, verifyAssets } from './windows-draft-release.mjs';

const repository = 'example/codas';
const sha = 'a'.repeat(40);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codas-draft-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const directory = path.join(root, 'dist');
  fs.mkdirSync(packageRoot); fs.mkdirSync(directory);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: 'fixture', sha256: hash('fixture'), size: 7 }] }) + '\n');
  fs.writeFileSync(path.join(packageRoot, 'payload-manifest.json'), manifest);
  fs.writeFileSync(path.join(packageRoot, 'release.json'), JSON.stringify({ schemaVersion: 1, versionId: VERSION, transportRevision: TRANSPORT, manifestSha256: hash(manifest), qualification: { stable: false, status: 'candidate' }, payloadArchive: { format: 'codas-payload-v1' } }) + '\n');
  fs.writeFileSync(path.join(directory, `${PACKAGE_NAME}.zip`), Buffer.from('PK\x03\x04fixture-archive'));
  const assets = await prepareAssets({ packageRoot, directory, repository, sha });
  return { directory, repository, sha, assets };
}
function draft(overrides = {}) {
  return { id: 7, tag_name: TAG, target_commitish: sha, draft: true, prerelease: true, published_at: null, upload_url: `https://uploads.github.com/repos/${repository}/releases/7/assets{?name,label}`, ...overrides };
}
function remoteAsset(local, id = 1) {
  return { id, name: local.name, size: local.size, state: 'uploaded', digest: `sha256:${local.sha256}` };
}
function fakeApi(options = {}) {
  const state = { release: options.release ?? null, publicTag: options.publicTag ?? false, assets: options.assets ?? [], mutations: [], checks: 0, hashes: 0 };
  const api = {
    async request(method, endpoint, body) {
      const pathname = endpoint.split('?')[0];
      if (method === 'GET' && pathname.endsWith(`/git/matching-refs/tags/${TAG}`)) return state.publicTag ? [{ ref: `refs/tags/${TAG}`, object: { sha, type: 'commit' } }] : [];
      if (method === 'GET' && pathname === `repos/${repository}/releases`) return state.release ? [structuredClone(state.release)] : [];
      if (method === 'POST' && pathname === `repos/${repository}/releases`) {
        assert.equal(body.draft, true); assert.equal(body.prerelease, true); assert.equal(body.make_latest, 'false');
        assert.equal(body.target_commitish, sha);
        state.mutations.push({ method, endpoint, body }); state.release = draft(body); return structuredClone(state.release);
      }
      if (method === 'GET' && pathname === `repos/${repository}/releases/7`) {
        state.checks++;
        if (options.publishBeforeCheck === state.checks) state.release = { ...state.release, draft: false, published_at: '2026-11-23T12:00:00Z' };
        return structuredClone(state.release);
      }
      if (method === 'GET' && pathname === `repos/${repository}/releases/7/assets`) return structuredClone(state.assets);
      throw new Error(`Unexpected fixture API call: ${method} ${endpoint}`);
    },
    async upload(url, local) {
      assert.equal(state.release.draft, true);
      assert.equal(new URL(url).searchParams.get('name'), local.name);
      state.mutations.push({ method: 'UPLOAD', name: local.name });
      const result = remoteAsset(local, state.assets.length + 1); state.assets.push(result); return result;
    },
    async assetHash(endpoint, size) {
      state.hashes++;
      const asset = state.assets.find(value => endpoint.endsWith('/' + value.id));
      assert.equal(asset.size, size); return options.hashes.get(asset.name);
    },
  };
  return { api, state };
}

test('candidate preparation pins the complete five-file publication inventory', async t => {
  const f = await fixture(t);
  const verified = await verifyAssets(f);
  assert.equal(verified.length, 5);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.directory, 'candidate-build.json')));
  assert.equal(metadata.sourceCommit, sha); assert.equal(metadata.qualification.stable, false);
  assert.match(draftNotes(sha), /另一设备访问授权目录并执行实际命令/);
  assert.match(draftNotes(sha), /依赖缺失检测与修复、升级与回退/);
  assert.match(draftNotes(sha), /固定时长连续运行不作为本轮发布的前置条件/);
  assert.match(draftNotes(sha), /自然睡眠\/唤醒和整机重启作为补充观察/);
  assert.doesNotMatch(draftNotes(sha), /24 小时|8 小时/);
});
test('new publication creates only a prerelease draft and uploads five verified assets', async t => {
  const f = await fixture(t); const remote = fakeApi();
  const result = await publishDraft({ ...f, api: remote.api });
  assert.equal(result.draft, true); assert.equal(result.published, false);
  assert.equal(result.uploaded.length, 5);
  assert.equal(remote.state.mutations.filter(call => call.method === 'POST').length, 1);
  assert.equal(remote.state.mutations.filter(call => call.method === 'UPLOAD').length, 5);
});
test('same-SHA rerun reuses the exact assets without replacement or metadata mutation', async t => {
  const f = await fixture(t); const remote = fakeApi({ release: draft(), assets: f.assets.map((asset, i) => remoteAsset(asset, i + 1)) });
  const result = await publishDraft({ ...f, api: remote.api });
  assert.deepEqual(result.uploaded, []); assert.deepEqual(remote.state.mutations, []);
});
for (const [name, options, pattern] of [
  ['public release', { release: draft({ draft: false, published_at: '2026-11-23T12:00:00Z' }) }, /public release/],
  ['public tag even at the same SHA', { publicTag: true }, /already exists publicly/],
  ['draft for a different SHA', { release: draft({ target_commitish: 'b'.repeat(40) }) }, /different commit/],
  ['draft for a mutable branch name', { release: draft({ target_commitish: 'release/windows-stable-test' }) }, /different commit/],
]) {
  test(`${name} is rejected without mutation`, async t => {
    const f = await fixture(t); const remote = fakeApi(options);
    await assert.rejects(publishDraft({ ...f, api: remote.api }), pattern);
    assert.deepEqual(remote.state.mutations, []);
  });
}
test('a differing existing asset blocks all uploads, including other missing assets', async t => {
  const f = await fixture(t);
  const changed = { ...remoteAsset(f.assets.at(-1)), digest: `sha256:${'0'.repeat(64)}` };
  const remote = fakeApi({ release: draft(), assets: [changed] });
  await assert.rejects(publishDraft({ ...f, api: remote.api }), /different bytes/);
  assert.deepEqual(remote.state.mutations, []);
});
test('unfinished upload remains untouched and blocks further mutation', async t => {
  const f = await fixture(t);
  const remote = fakeApi({ release: draft(), assets: [{ ...remoteAsset(f.assets[0]), state: 'starter' }] });
  await assert.rejects(publishDraft({ ...f, api: remote.api }), /incomplete/);
  assert.deepEqual(remote.state.mutations, []);
});
test('legacy assets without server digest are compared by downloaded bytes', async t => {
  const f = await fixture(t);
  const remote = fakeApi({ release: draft(), assets: f.assets.map((asset, i) => ({ ...remoteAsset(asset, i + 1), digest: null })), hashes: new Map(f.assets.map(asset => [asset.name, asset.sha256])) });
  await publishDraft({ ...f, api: remote.api });
  assert.ok(remote.state.hashes >= 5); assert.deepEqual(remote.state.mutations, []);
});
test('concurrent publication observed before upload is rejected without unpublishing', async t => {
  const f = await fixture(t); const remote = fakeApi({ release: draft(), publishBeforeCheck: 1 });
  await assert.rejects(publishDraft({ ...f, api: remote.api }), /public release/);
  assert.deepEqual(remote.state.mutations, []); assert.equal(remote.state.release.draft, false);
});
test('changed downloaded artifact fails before contacting GitHub', async t => {
  const f = await fixture(t);
  fs.appendFileSync(path.join(f.directory, `${PACKAGE_NAME}.zip`), 'changed');
  await assert.rejects(publishDraft({ ...f, api: { request() { throw new Error('must not contact GitHub'); } } }), /ZIP differs/);
});
test('artifact for another checkout cannot be attached', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyAssets({ ...f, sha: 'b'.repeat(40) }), /does not match/);
});
test('release permission refusal explains the workflow scope without exposing the token', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  await assert.rejects(githubApi('fixture-token').request('POST', `repos/${repository}/releases`, {}), error => {
    assert.match(error.message, /workflow-write/); assert.match(error.message, /already retained/);
    assert.doesNotMatch(error.message, /fixture-token/); return true;
  });
});
