// Pure local checks only. No Windows payload, network, process launch, pairing,
// acceptance claim, or downloaded package is used by this preparation check.
import assert from 'node:assert/strict';
import { validateBinding, safeEvidence } from './full-package-smoke.mjs';

const binding = {
  schemaVersion: 1, repository: 'SeanWu089/Codas-Router', repositoryId: 1381092909,
  sourceCommit: 'd53073494906f0804a189b1a37ca1bf932ac982e',
  candidateRunId: 45112363505, candidateRunAttempt: 1, candidateArtifactId: 14789873723,
  artifactName: 'Codas-Windows-0.2.0-rc.4-d53073494906f0804a189b1a37ca1bf932ac982e-1',
  artifactSize: 242499737, artifactDigest: 'sha256:81670c15fef66a7404a89d1585b9af2cac99b97ddd7e16478569d42ea26c06db',
  zipSize: 233876957, zipSha256: '2d815421c0133412f630dbfaba8d248441fa1c959b44745891cf1216c9fe8991',
  manifestSha256: '4c1f16e691f9660d9c5f73d8ec582517045c4b4077a37853745b805a0c5ef3e2',
};
// This in-memory object tests receipt comparison, not a claim of an API lookup.
assert.equal(validateBinding(binding, { ...binding, verified: true }), binding);
assert.throws(() => validateBinding(binding, { ...binding, candidateArtifactId: 1, verified: true }), /NOT_VERIFIED/);
assert.throws(() => validateBinding({ ...binding, sourceCommit: 'placeholder' }, { ...binding, verified: true }), /INVALID_CANDIDATE_BINDING/);
assert.throws(() => validateBinding(binding, { ...binding, verified: false }), /NOT_VERIFIED/);
const sanitized = safeEvidence({ passed: false, code: 'EACCES', syscall: 'mkdir', stdoutSha256: 'a'.repeat(64), ownerToken: 'do-not-retain', access_token: 'do-not-retain', args: ['do-not-retain'], nodePath: 'do-not-retain', environment: { SECRET: 'do-not-retain' }, message: 'do-not-retain', failed: { code: 'RUNTIME_OPERATION_FAILED', causeCode: 'EACCES', secret: 'do-not-retain' } });
assert.deepEqual(sanitized, { passed: false, code: 'EACCES', syscall: 'mkdir', stdoutSha256: 'a'.repeat(64), failed: { code: 'RUNTIME_OPERATION_FAILED', causeCode: 'EACCES' } });
assert.equal(JSON.stringify(sanitized).includes('do-not-retain'), false);
console.log(JSON.stringify({ passed: true, scope: 'binding-validation-and-diagnostic-sanitization-only', nativePackageExecuted: false, networkUsed: false }));
