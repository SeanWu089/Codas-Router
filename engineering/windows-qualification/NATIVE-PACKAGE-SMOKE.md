# Actual complete Windows package smoke

This prepared helper checks the real candidate archive on a fresh GitHub-hosted
Windows runner. It does not mock the backend or OAuth/MCP calls. It does not
qualify SEANSWPC, Task Scheduler, remote plugin access or a stable release.
No full candidate archive was downloaded or executed during preparation.

## Files to add on the independent package-check branch

| Prepared file | Repository destination |
| --- | --- |
| `full-package-smoke.mjs` | `scripts/windows/ci/full-package-smoke.mjs` |
| `Expand-CandidateOuter.ps1` | `scripts/windows/ci/Expand-CandidateOuter.ps1` |
| `native-module-probe.cjs` | `scripts/windows/ci/native-module-probe.cjs` |
| `verify-candidate-binding.mjs` | `scripts/windows/ci/verify-candidate-binding.mjs` |
| `windows-package-check.json` | `.github/windows-package-check.json` |
| `windows-package-check.yml` | `.github/workflows/windows-package-check.yml` |

The workflow notes describe its additional sanitized-console helper, if present.
`self-check.mjs` is an optional local preparation check and is not needed by the
actual workflow. The prepared files remain outside the current repository.

The committed binding identifies candidate source
`d53073494906f0804a189b1a37ca1bf932ac982e`, successful run `45112363505`,
attempt `1`, and artifact `14789873723`. It also pins the artifact's metadata,
inner ZIP size/hash and payload manifest hash. The preflight must produce a
matching verified receipt before the smoke can run. The independent branch is
`release/windows-package-check-20261123`; it does not rewrite the candidate
commit or unpublished rc.4 draft.

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
IPC shutdown is attempted before any forced termination of an owned handle.

## Results and diagnostics

The report directory contains only:

- `native-package-smoke.json`: exact artifact binding, stage results, child
  exit statuses, output byte counts/digests, whitelisted failures and cleanup.
- `runtime-events.sanitized.json`: whitelisted structured product runtime events.

No absolute workspace paths, child command lines, environment values, free-form
error messages, credentials, raw child output, state/profile files or diagnostic
archive are included. Successful temporary state is removed; failed private
state stays on the ephemeral runner for the remaining job lifetime and is not
uploaded. Console/report output always states that physical-PC, Task Scheduler,
remote and stable qualification are false.

Preparation checks passed: Node 22 syntax, pure binding/sanitization checks,
PowerShell syntax and three small self-contained ZIP helper checks (regular
member accepted; traversal and link rejected) under Linux PowerShell 7.5.4.
These checks did not execute a Windows payload and are not native acceptance.
The actual bound archive must now be run by the independent Windows workflow.
