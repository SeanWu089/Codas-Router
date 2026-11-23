// Pure local checks only. No Windows payload, network, process launch, pairing,
// acceptance claim, or downloaded package is used by this preparation check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateBinding, safeEvidence } from './full-package-smoke.mjs';

// Read the exact branch binding so this check cannot silently exercise an older
// candidate after a rebind. The receipt below remains a local validation fixture.
const binding = JSON.parse(fs.readFileSync(new URL('../../../.github/windows-package-check.json', import.meta.url), 'utf8'));
// This in-memory object tests receipt comparison, not a claim of an API lookup.
assert.equal(validateBinding(binding, { ...binding, verified: true }), binding);
assert.throws(() => validateBinding(binding, { ...binding, candidateArtifactId: 1, verified: true }), /NOT_VERIFIED/);
assert.throws(() => validateBinding({ ...binding, sourceCommit: 'placeholder' }, { ...binding, verified: true }), /INVALID_CANDIDATE_BINDING/);
assert.throws(() => validateBinding(binding, { ...binding, verified: false }), /NOT_VERIFIED/);
assert.throws(() => validateBinding({ ...binding, artifactName: binding.artifactName.replace('-rc.5-', '-rc.4-') }, { ...binding, verified: true }), /INVALID_CANDIDATE_BINDING/);
assert.throws(() => validateBinding(binding, { ...binding, manifestSha256: '0'.repeat(64), verified: true }), /NOT_VERIFIED/);
const sanitized = safeEvidence({ passed: false, code: 'EACCES', syscall: 'mkdir', stdoutSha256: 'a'.repeat(64), ownerToken: 'do-not-retain', access_token: 'do-not-retain', args: ['do-not-retain'], nodePath: 'do-not-retain', environment: { SECRET: 'do-not-retain' }, message: 'do-not-retain', failed: { code: 'RUNTIME_OPERATION_FAILED', causeCode: 'EACCES', secret: 'do-not-retain' } });
assert.deepEqual(sanitized, { passed: false, code: 'EACCES', syscall: 'mkdir', stdoutSha256: 'a'.repeat(64), failed: { code: 'RUNTIME_OPERATION_FAILED', causeCode: 'EACCES' } });
assert.equal(JSON.stringify(sanitized).includes('do-not-retain'), false);
console.log(JSON.stringify({ passed: true, scope: 'binding-validation-and-diagnostic-sanitization-only', nativePackageExecuted: false, networkUsed: false }));
