// CI-only candidate packaging metadata and draft asset publication.
// No PATCH/DELETE, Git ref mutation, asset replacement, or stable promotion.
// API semantics: https://docs.github.com/en/rest/releases/releases
// Asset digests: https://docs.github.com/en/rest/releases/assets
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TAG = 'windows-v0.2.0-rc.5';
export const PACKAGE_NAME = 'Codas-Windows-0.2.0-rc.5';
export const VERSION = 'windows-0.2.0-rc.5-c1497ca';
export const TRANSPORT = 'c1497cac73c8d147dfcd74127018be470ae8a72a';
const ZIP = `${PACKAGE_NAME}.zip`;
const DATA_FILES = [ZIP, 'candidate-build.json', 'release.json', 'payload-manifest.json'];
const ASSETS = [...DATA_FILES, 'SHA256SUMS'];
const hex = /^[a-f0-9]{40}$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const title = 'Codas Windows 0.2.0-rc.5 — 候选草稿';

function identity(repository, sha) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || '') || !hex.test(sha || '')) throw new Error('Repository and full lowercase source SHA are required.');
}
function regular(directory, name) {
  const filename = path.join(directory, name);
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-regular candidate asset: ${name}`);
  return { filename, size: info.size };
}
function readJson(directory, name) {
  const { filename, size } = regular(directory, name);
  if (size > 32 * 1024 * 1024) throw new Error(`Oversized candidate metadata: ${name}`);
  const bytes = fs.readFileSync(filename);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
function candidate(release, manifestBytes) {
  if (release.schemaVersion !== 1 || release.versionId !== VERSION || release.transportRevision !== TRANSPORT || release.qualification?.stable !== false || release.qualification?.status !== 'candidate' || release.manifestSha256 !== sha256(manifestBytes) || release.payloadArchive?.format !== 'codas-payload-v1') throw new Error('Only this exact compact candidate, with stable=false, may be attached.');
}
async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function draftNotes(sha) {
  if (!hex.test(sha || '')) throw new Error('A full lowercase source SHA is required.');
  return [
    '# Codas Windows 0.2.0-rc.5 候选草稿', '',
    '**这是未公开的候选草稿，尚未通过稳定版验收。** 安装包携带固定版本的 Node、DevSpace 依赖和 Windows 原生模块，可离线安装；配对和远程使用仍需网络。', '',
    `- 构建提交：\`${sha}\`。核心传输冻结于 \`${TRANSPORT}\`。`,
    '- CI 检查 Windows Node 22/24、Windows PowerShell 5.1 脚本与安装事务场景，并校验完整包及 SHA-256；这些结果不代表实机稳定性验收已经完成。',
    '- 待完成约定的实机使用场景：开启/停止、另一设备访问授权目录并执行实际命令、进程重启和断线恢复、依赖缺失检测与修复、升级与回退。固定时长连续运行不作为本轮发布的前置条件。',
    '- 长时间运行、自然睡眠/唤醒和整机重启作为补充观察；未实际执行的场景不标为通过，不为验收强制睡眠或重启电脑。',
    '- 当前范围：Windows 登录后启用 Codas，通过现有 HTTPS 入口访问明确授权的工作目录。去中心化和核心机自动接替不在本版范围。',
    '- 升级保留安装身份、授权目录和会话序号；缺失或损坏依赖留下证据，不自动绕过安全策略、重新配对或替换身份。', '',
    '约定使用场景验收通过前保持草稿和候选标记，不将本包声明为最新稳定版。下载后先核对 `SHA256SUMS`，安装说明见包内 `README-WINDOWS.md`。', '',
  ].join('\n');
}

export async function prepareAssets({ packageRoot, directory, repository, sha }) {
  identity(repository, sha);
  const release = readJson(packageRoot, 'release.json');
  const manifest = readJson(packageRoot, 'payload-manifest.json');
  candidate(release.value, manifest.bytes);
  const zip = regular(directory, ZIP);
  if (zip.size < 4 || zip.size > 1024 * 1024 * 1024) throw new Error('Unexpected candidate ZIP size.');
  for (const name of ['release.json', 'payload-manifest.json']) fs.copyFileSync(path.join(packageRoot, name), path.join(directory, name), fs.constants.COPYFILE_EXCL);
  const metadata = {
    schemaVersion: 1, repository, sourceCommit: sha, tag: TAG,
    versionId: VERSION, transportRevision: TRANSPORT, manifestSha256: release.value.manifestSha256,
    qualification: { stable: false, status: 'candidate', usageScenarioQualification: 'pending' },
    archive: { name: ZIP, size: zip.size, sha256: await fileHash(zip.filename) },
  };
  fs.writeFileSync(path.join(directory, 'candidate-build.json'), jsonBytes(metadata), { flag: 'wx' });
  const checksums = [];
  for (const name of DATA_FILES) checksums.push(`${await fileHash(regular(directory, name).filename)}  ${name}`);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n', { flag: 'wx' });
  return verifyAssets({ directory, repository, sha });
}

export async function verifyAssets({ directory, repository, sha }) {
  identity(repository, sha);
  const names = fs.readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ASSETS].sort())) throw new Error('Candidate artifact inventory differs from the five expected files.');
  const metadata = readJson(directory, 'candidate-build.json').value;
  const release = readJson(directory, 'release.json');
  const manifest = readJson(directory, 'payload-manifest.json');
  candidate(release.value, manifest.bytes);
  if (metadata.schemaVersion !== 1 || metadata.repository !== repository || metadata.sourceCommit !== sha || metadata.tag !== TAG || metadata.versionId !== VERSION || metadata.transportRevision !== TRANSPORT || metadata.manifestSha256 !== release.value.manifestSha256 || metadata.qualification?.stable !== false || metadata.qualification?.status !== 'candidate' || metadata.archive?.name !== ZIP) throw new Error('Candidate artifact does not match this repository, commit, or candidate qualification.');
  const assets = [];
  for (const name of ASSETS) {
    const info = regular(directory, name);
    assets.push({ name, ...info, sha256: await fileHash(info.filename) });
  }
  const zip = assets.find(asset => asset.name === ZIP);
  if (zip.size !== metadata.archive.size || zip.sha256 !== metadata.archive.sha256) throw new Error('Candidate ZIP differs from its build metadata.');
  const checksums = assets.filter(asset => DATA_FILES.includes(asset.name)).map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('SHA256SUMS does not match all candidate assets.');
  return assets;
}

async function pages(api, endpoint) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const items = await api.request('GET', `${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error('GitHub returned an invalid paginated inventory.');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('GitHub inventory exceeded the bounded pagination limit.');
}
function safeDraft(release, sha) {
  if (!Number.isSafeInteger(release?.id) || release.id < 1 || release.tag_name !== TAG || release.draft !== true || release.published_at != null || release.prerelease !== true) throw new Error('Refusing a public release or a release that is not this prerelease draft.');
  if (release.target_commitish !== sha) throw new Error('Existing draft targets a different commit; choose a new candidate instead of retargeting it.');
}
async function noPublicTag(api, repository) {
  const refs = await api.request('GET', `repos/${repository}/git/matching-refs/tags/${TAG}`);
  if (!Array.isArray(refs)) throw new Error('GitHub tag inventory is invalid.');
  if (refs.some(ref => ref.ref === `refs/tags/${TAG}`)) throw new Error('This tag already exists publicly; refusing to change or reuse it.');
}
async function sameAsset(api, repository, remote, local) {
  if (!Number.isSafeInteger(remote.id) || remote.id < 1 || remote.state !== 'uploaded' || remote.size !== local.size) throw new Error(`Existing asset differs or is incomplete: ${local.name}; no replacement is allowed.`);
  const digest = /^sha256:[a-f0-9]{64}$/.test(remote.digest || '') ? remote.digest.slice(7) : await api.assetHash(`repos/${repository}/releases/assets/${remote.id}`, local.size);
  if (digest !== local.sha256) throw new Error(`Existing asset has different bytes: ${local.name}; no replacement is allowed.`);
}
function indexAssets(assets) {
  const result = new Map();
  for (const asset of assets) {
    if (result.has(asset.name)) throw new Error('Duplicate release asset names; refusing mutation.');
    result.set(asset.name, asset);
  }
  return result;
}

export async function publishDraft({ directory, repository, sha, api }) {
  const assets = await verifyAssets({ directory, repository, sha });
  // Listing releases includes drafts for the authorized contents-write job.
  // A tag lookup alone does not provide a complete draft inventory.
  const matches = (await pages(api, `repos/${repository}/releases`)).filter(release => release.tag_name === TAG);
  await noPublicTag(api, repository);
  if (matches.length > 1) throw new Error('Multiple releases use this tag; refusing mutation.');
  let release = matches[0];
  if (release) safeDraft(release, sha);
  if (!release) {
    release = await api.request('POST', `repos/${repository}/releases`, {
      tag_name: TAG, target_commitish: sha, name: title, body: draftNotes(sha),
      draft: true, prerelease: true, make_latest: 'false', generate_release_notes: false,
    });
    safeDraft(release, sha);
  }
  const base = `repos/${repository}/releases/${release.id}`;
  let remote = indexAssets(await pages(api, `${base}/assets`));
  // Check every collision before uploading even one missing asset.
  for (const asset of assets) if (remote.has(asset.name)) await sameAsset(api, repository, remote.get(asset.name), asset);
  const uploaded = [];
  for (const asset of assets) {
    safeDraft(await api.request('GET', base), sha);
    await noPublicTag(api, repository);
    remote = indexAssets(await pages(api, `${base}/assets`));
    if (remote.has(asset.name)) { await sameAsset(api, repository, remote.get(asset.name), asset); continue; }
    const uploadUrl = new URL(release.upload_url.split('{', 1)[0]);
    if (uploadUrl.origin !== 'https://uploads.github.com' || uploadUrl.pathname !== `/${base}/assets` || uploadUrl.search || uploadUrl.username || uploadUrl.password) throw new Error('Unexpected GitHub asset upload endpoint.');
    uploadUrl.searchParams.set('name', asset.name);
    const added = await api.upload(uploadUrl.href, asset);
    if (added.name !== asset.name) throw new Error('GitHub renamed a candidate asset; manual review required.');
    await sameAsset(api, repository, added, asset);
    uploaded.push(asset.name);
  }
  safeDraft(await api.request('GET', base), sha);
  await noPublicTag(api, repository);
  remote = indexAssets(await pages(api, `${base}/assets`));
  for (const asset of assets) {
    if (!remote.has(asset.name)) throw new Error('A candidate asset disappeared during verification.');
    await sameAsset(api, repository, remote.get(asset.name), asset);
  }
  return { draft: true, published: false, tag: TAG, sourceCommit: sha, releaseId: release.id, uploaded, assets: assets.map(({ name, size, sha256: hash }) => ({ name, size, sha256: hash })) };
}

export function githubApi(token) {
  if (!token) throw new Error('GH_TOKEN is required only for the draft publication step.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'CodasWindowsCandidateCI' };
  async function jsonResponse(response, operation) {
    if (!response.ok) {
      const permission = operation === 'POST release' && [403, 404].includes(response.status)
        ? ' A target that changes workflow files may need workflow-write authority unavailable to GITHUB_TOKEN. An authorized maintainer can pre-create the exact-SHA prerelease draft; the CI artifact is already retained. See https://docs.github.com/en/rest/releases/releases#create-a-release .'
        : '';
      throw new Error(`GitHub ${operation} refused with HTTP ${response.status}.${permission}`);
    }
    return response.json();
  }
  return {
    async request(method, endpoint, body) {
      if (!['GET', 'POST'].includes(method) || !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(endpoint)) throw new Error('Unsupported GitHub API operation.');
      const operation = method === 'POST' && endpoint.endsWith('/releases') ? 'POST release' : method;
      const response = await fetch(`https://api.github.com/${endpoint}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
      return jsonResponse(response, operation);
    },
    async upload(url, asset) {
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': asset.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream', 'Content-Length': String(asset.size) }, body: fs.createReadStream(asset.filename), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(600000) });
      return jsonResponse(response, 'asset upload');
    },
    async assetHash(endpoint, expectedSize) {
      const response = await fetch(`https://api.github.com/${endpoint}`, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
      if (!response.ok || !response.body) throw new Error('Could not verify existing asset bytes; refusing replacement.');
      const hash = crypto.createHash('sha256'); let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expectedSize) throw new Error('Existing asset exceeds its expected size.');
        hash.update(chunk);
      }
      if (size !== expectedSize) throw new Error('Existing asset has an unexpected download size.');
      return hash.digest('hex');
    },
  };
}

async function main(argv) {
  const mode = argv.shift(); const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--sha': 'sha', '--repository': 'repository', '--dist': 'directory', '--package-root': 'packageRoot' }[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) throw new Error('Invalid CI helper arguments.');
    options[key] = argv[i + 1];
  }
  if (mode === 'notes') { process.stdout.write(draftNotes(options.sha)); return; }
  if (!options.directory) throw new Error('--dist is required.');
  if (mode === 'prepare') {
    if (!options.packageRoot) throw new Error('--package-root is required.');
    const assets = await prepareAssets(options);
    process.stdout.write(JSON.stringify({ candidate: true, stable: false, assets: assets.map(({ name, size, sha256: hash }) => ({ name, size, sha256: hash })) }) + '\n');
  } else if (mode === 'publish') {
    const result = await publishDraft({ ...options, api: githubApi(process.env.GH_TOKEN) });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows candidate draft\n\nTag: \`${TAG}\` · commit: \`${options.sha}\`\n\nFive verified assets are attached to an unpublished prerelease draft. Stable qualification remains pending.\n`);
  } else throw new Error('Use prepare, notes, or publish.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Candidate draft refused: ${error.message}\n`); process.exitCode = 1; });
}
