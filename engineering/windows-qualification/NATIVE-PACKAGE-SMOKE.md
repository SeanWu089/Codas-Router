# Actual complete Windows package smoke

This engineering helper checks the real candidate archive on a fresh GitHub-hosted
Windows runner. It does not mock the backend or OAuth/MCP calls. It does not
qualify SEANSWPC, Task Scheduler, remote plugin access or a stable release.
The exact RC5 candidate completed a successful full-package run on 2026-11-23:
<https://github.com/SeanWu089/Codas-Router/actions/runs/45116052919>,
job `137499042914`, attempt `1`, engineering commit
`25a9f3f12a8d2b29d470a162853b208d9712b2f4`. Historical RC4 failures remain
recorded separately in `HANDOFF-20261123.md`.

## Files on the independent package-check branch

| Prepared file | Repository destination |
| --- | --- |
| `full-package-smoke.mjs` | `scripts/windows/ci/full-package-smoke.mjs` |
| `Expand-CandidateOuter.ps1` | `scripts/windows/ci/Expand-CandidateOuter.ps1` |
| `native-module-probe.cjs` | `scripts/windows/ci/native-module-probe.cjs` |
| `verify-candidate-binding.mjs` | `scripts/windows/ci/verify-candidate-binding.mjs` |
| `windows-package-check.json` | `.github/windows-package-check.json` |
| `windows-package-check.yml` | `.github/workflows/windows-package-check.yml` |

The workflow notes describe its additional sanitized-console helper.
`self-check.mjs` is an optional local preparation check and is not needed by the
actual workflow. These files belong to the separate engineering branch.

The RC5 engineering branch is based exactly on candidate source
`a9c8e888b3c82491e892b7d428f05660ae4717e4`, whose CI run is `45115505375`.
The committed JSON pins attempt `1`, artifact `14791501882`, its exact metadata,
inner ZIP size/hash and payload manifest hash supplied by the release coordinator
after successful candidate assembly. It contains no floating or pending fields.
The successful run's preflight produced a matching verified receipt before the
smoke executed the bound package.
The independent branch is `release/windows-package-check-rc5-20261123`; it does
not rewrite the candidate commit or the historical RC4 draft.

## Exact scope

1. Reuse the candidate's `verifyAssets` helper to verify all five asset files,
   SHA256SUMS, repository and source commit; additionally compare the ZIP and
   manifest with the explicitly committed binding.
2. Extract only the short outer ZIP using Windows PowerShell, rejecting path
   traversal, links, aliases and non-regular members. Verify every bundled
   installer/bootstrap pin before executing the bundled Node or extractor.
3. Use the product's actual `Unpack-Payload.mjs` to restore its complete payload
   into a new version directory. Do not invoke the installer or register tasks.
4. Under the actual bundled Windows Node 22.23.3, perform an in-memory SQLite
   query, load the three included Windows node-pty native addons, and call
   `GetCurrentProcessId` through Koffi. No provider executable or login is used.
5. Run the product's actual `init-state.mjs` against new state and one empty,
   explicitly authorized workspace. This also performs product full-payload
   verification. The owner token is newly generated and stays private.
6. Start the actual product supervisor as an owned ChildProcess. Run the actual
   `probe.mjs`: local OAuth, MCP workspace opening and real `hostname` execution
   must succeed and match the runner. The receipt must remain local-ready with
   no paired outbound agent.
7. Request STOP through the product control API, using the same explicit version
   arguments and matching instance. Observe clean shutdown, supervisor exit and
   closure of the loopback listener. A forced stop is a test failure.

All work occurs beneath a canonical, newly allocated temporary directory.
Children receive a fresh private Windows profile and only required OS variables
and existing network/security controls; service credentials are not forwarded.
Unexpected Node preload/module-path injection is refused rather than cleared.
No execution-policy change, task action, pairing, production state access,
whole-PC network change, provider authentication or dependency download occurs.

Each child has a deadline. The controller has a 20-minute total limit plus
bounded shutdown; the workflow gives the smoke step 22 minutes and the job
30 minutes. Cleanup signals only retained ChildProcess handles created by the
helper. It never kills a PID obtained from a receipt or process listing. Product
STOP and natural exit observation precede any forced termination of an owned
handle. The supervisor has no extra parent IPC channel, matching the actual
PowerShell launcher; the product's internal child IPC remains unchanged.

## Results and diagnostics

The actual RC5 run passed all five asset checks and extracted 28 outer files
(306,074,870 bytes) plus 38,432 payload files (672,561,559 bytes). The bundled
Windows x64 Node 22.23.3 / ABI 127, SQLite query, three node-pty native addons and
Koffi call passed. The real backend started with fresh isolated, unpaired state;
authenticated OAuth/MCP workspace opening and `hostname` passed.

Product STOP passed. The supervisor exited cleanly with code 0 without a parent
IPC disconnection or forced termination; the loopback listener closed, every
owned child handle exited and private temporary state was removed.

The sanitized report artifact is `14791926340`, named
`Codas-Windows-Package-Smoke-25a9f3f12a8d2b29d470a162853b208d9712b2f4-1`,
`2117` bytes, digest
`sha256:dd2616e7de564c330144ef32046362279b45d53cf609f7488b31a1ce8c96a6b1`.
The parsed evidence is retained in
[RC5-CI-EVIDENCE-20261123.json](RC5-CI-EVIDENCE-20261123.json).

The report directory contains only:

- `native-package-smoke.json`: exact artifact binding, stage results, child
  exit statuses, output byte counts/digests, whitelisted failures and cleanup.
- `runtime-events.sanitized.json`: whitelisted structured product runtime events.

No absolute workspace paths, child command lines, environment values, free-form
error messages, credentials, raw child output, state/profile files or diagnostic
archive are included. Successful temporary state is removed; failed private
state stays on the ephemeral runner for the remaining job lifetime and is not
uploaded. Console/report output always states that physical-PC, Task Scheduler,
remote and stable qualification are false. The successful report also retains
`paired:false`. Actual SeansWPC installation, Task Scheduler/logon, stop/start,
missing-file repair, rollback and other-device Codas access remain pending while
the execution channel returns `-32603`.

Original RC4 preparation checks passed: Node 22 syntax, pure binding/sanitization checks,
PowerShell syntax and three small self-contained ZIP helper checks (regular
member accepted; traversal and link rejected) under Linux PowerShell 7.5.4.
These preparation checks did not execute a Windows payload and are not native
acceptance. The RC5 rebind's own local binding/sanitization self-check passed under
Node 22.23.3, including old-version and mismatched-receipt rejections. Syntax,
read-only workflow integration and protected-source equivalence checks passed.
The later successful native run above supplies the actual RC5 package-execution
evidence. The earlier preparation checks and RC4 payload results remain separate
historical evidence.
