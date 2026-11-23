// Read-only GitHub metadata preflight for the exact candidate Actions artifact.
// No release API, archive download, checkout, source mutation, or Git ref update.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FIELDS = ['schemaVersion', 'repository', 'repositoryId', 'sourceCommit',
  'candidateRunId', 'candidateRunAttempt', 'candidateArtifactId', 'artifactName',
  'artifactSize', 'artifactDigest', 'zipSize', 'zipSha256', 'manifestSha256'];
const PROTECTED_PATHS = [
  'src', 'dependencies', 'package.json', 'package-lock.json', 'LICENSE',
  'scripts/windows/stable', 'test',
  '.github/workflows/windows-stable-validation.yml',
  '.github/scripts/windows-draft-release.mjs',
  '.github/scripts/windows-draft-release.test.mjs',
];
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const sameRepository = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };

function options() {
  const values = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--binding-file', '--receipt-file'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(values, key)) fail('INVALID_ARGUMENTS');
    values[key] = value;
  }
  if (!values['--binding-file'] || !values['--receipt-file']) fail('BINDING_AND_RECEIPT_PATHS_REQUIRED');
  return values;
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('LOCAL_GIT_BINDING_CHECK_FAILED');
  return result.stdout.trim();
}
function readBinding(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 65536) fail('BINDING_MUST_BE_A_BOUNDED_REGULAR_FILE');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('BINDING_JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...FIELDS].sort())) fail('BINDING_SCHEMA_INVALID');
  if (value.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repository) || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || !['repositoryId', 'candidateRunId', 'candidateRunAttempt', 'candidateArtifactId', 'artifactSize', 'zipSize'].every(key => positive(value[key])) || value.artifactSize > 1024 * 1024 * 1024 || value.zipSize > 1024 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest) || !/^[a-f0-9]{64}$/.test(value.zipSha256) || !/^[a-f0-9]{64}$/.test(value.manifestSha256) || value.artifactName !== `Codas-Windows-0.2.0-rc.4-${value.sourceCommit}-${value.candidateRunAttempt}`) fail('BINDING_PIN_INVALID');
  return value;
}
async function get(repository, endpoint) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'CodasWindowsPackageBinding' }
  });
  if (!response.ok) fail(`GITHUB_METADATA_HTTP_${response.status}`);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) fail('GITHUB_METADATA_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('GITHUB_METADATA_JSON_INVALID'); }
}
function verifyRun(run, binding) {
  if (run.id !== binding.candidateRunId || run.run_attempt !== binding.candidateRunAttempt || run.head_sha !== binding.sourceCommit || run.status !== 'completed' || run.conclusion !== 'success' || !['push', 'workflow_dispatch'].includes(run.event) || !/^release\/windows-stable-/.test(run.head_branch || '') || run.repository?.id !== binding.repositoryId || run.head_repository?.id !== binding.repositoryId || !sameRepository(run.repository?.full_name, binding.repository) || !sameRepository(run.head_repository?.full_name, binding.repository) || !positive(run.workflow_id)) fail('CANDIDATE_RUN_BINDING_MISMATCH');
}

try {
  const values = options();
  if (process.version !== 'v22.23.3') fail('PINNED_NODE_22_23_3_REQUIRED');
  if (process.env.GITHUB_EVENT_NAME !== 'push' || !/^refs\/heads\/release\/windows-package-check-/.test(process.env.GITHUB_REF || '') || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) fail('EXPLICIT_PACKAGE_CHECK_BRANCH_PUSH_REQUIRED');
  if (!process.env.GITHUB_WORKSPACE || !process.env.RUNNER_TEMP || !process.env.GH_TOKEN || !process.env.GITHUB_OUTPUT) fail('REQUIRED_ACTIONS_ENVIRONMENT_MISSING');
  const root = fs.realpathSync(process.env.GITHUB_WORKSPACE);
  const requestedBinding = path.resolve(values['--binding-file']);
  const bindingFile = fs.realpathSync(requestedBinding);
  if (!inside(root, bindingFile)) fail('BINDING_PATH_OUTSIDE_CANONICAL_CHECKOUT');
  const binding = readBinding(requestedBinding);
  if (!sameRepository(binding.repository, process.env.GITHUB_REPOSITORY)) fail('CHECKOUT_REPOSITORY_MISMATCH');
  if (process.env.GITHUB_REPOSITORY_ID && Number(process.env.GITHUB_REPOSITORY_ID) !== binding.repositoryId) fail('CHECKOUT_REPOSITORY_ID_MISMATCH');
  if (git(root, ['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA) fail('CHECKOUT_SHA_MISMATCH');
  git(root, ['cat-file', '-e', `${binding.sourceCommit}^{commit}`]);
  git(root, ['merge-base', '--is-ancestor', binding.sourceCommit, process.env.GITHUB_SHA]);
  if (git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', binding.sourceCommit, process.env.GITHUB_SHA, '--', ...PROTECTED_PATHS])) fail('PRODUCT_OR_VALIDATION_INPUTS_CHANGED_FROM_CANDIDATE');
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) fail('TRACKED_CHECKOUT_FILES_CHANGED');

  const run = await get(binding.repository, `actions/runs/${binding.candidateRunId}`);
  verifyRun(run, binding);
  const workflow = await get(binding.repository, `actions/workflows/${run.workflow_id}`);
  if (workflow.path !== '.github/workflows/windows-stable-validation.yml') fail('CANDIDATE_WORKFLOW_MISMATCH');
  const jobs = await get(binding.repository, `actions/runs/${binding.candidateRunId}/jobs?filter=latest&per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) fail('CANDIDATE_JOB_INVENTORY_INCOMPLETE');
  const packaging = jobs.jobs.filter(job => job.name === 'Build complete offline candidate');
  if (packaging.length !== 1 || packaging[0].run_id !== binding.candidateRunId || packaging[0].status !== 'completed' || packaging[0].conclusion !== 'success' || (packaging[0].run_attempt !== undefined && packaging[0].run_attempt !== binding.candidateRunAttempt) || (packaging[0].head_sha !== undefined && packaging[0].head_sha !== binding.sourceCommit)) fail('CANDIDATE_PACKAGE_JOB_NOT_SUCCESSFUL_FOR_PINNED_ATTEMPT');
  const artifact = await get(binding.repository, `actions/artifacts/${binding.candidateArtifactId}`);
  const provenance = artifact.workflow_run;
  if (artifact.id !== binding.candidateArtifactId || artifact.name !== binding.artifactName || artifact.size_in_bytes !== binding.artifactSize || artifact.digest !== binding.artifactDigest || artifact.expired !== false || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now() || provenance?.id !== binding.candidateRunId || provenance.head_sha !== binding.sourceCommit || provenance.repository_id !== binding.repositoryId || provenance.head_repository_id !== binding.repositoryId) fail('CANDIDATE_ARTIFACT_BINDING_MISMATCH');
  // Do not mix metadata from an overlapping rerun or a changed latest attempt.
  verifyRun(await get(binding.repository, `actions/runs/${binding.candidateRunId}`), binding);

  const requestedReceipt = path.resolve(values['--receipt-file']);
  const receiptFile = path.join(fs.realpathSync(path.dirname(requestedReceipt)), path.basename(requestedReceipt));
  const canonicalTemp = fs.realpathSync(process.env.RUNNER_TEMP);
  if (!inside(canonicalTemp, receiptFile)) fail('RECEIPT_PATH_OUTSIDE_CANONICAL_RUNNER_TEMP');
  const receipt = { ...binding, verified: true };
  const handle = fs.openSync(receiptFile, 'wx', 0o600);
  try { fs.writeFileSync(handle, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `repository=${binding.repository}\ncandidate_run_id=${binding.candidateRunId}\ncandidate_artifact_id=${binding.candidateArtifactId}\n`);
  console.log(JSON.stringify({ verified: true, repository: binding.repository, sourceCommit: binding.sourceCommit,
    candidateRunId: binding.candidateRunId, candidateRunAttempt: binding.candidateRunAttempt,
    candidateArtifactId: binding.candidateArtifactId, productInputsUnchanged: true,
    downloaded: false, physicalWindowsQualification: false }));
} catch (error) {
  console.error(JSON.stringify({ verified: false, code: error.safeCode || 'BINDING_PREFLIGHT_FAILED' }));
  process.exitCode = 1;
}

// API schema references; all requests above are GET metadata requests only.
// https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
// https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
// https://docs.github.com/en/rest/actions/artifacts#get-an-artifact
