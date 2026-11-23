# Exact candidate package: native Windows CI template

Prepared outside the source repository. No workflow, GitHub API request, full
artifact download, remote-machine operation, or qualification handoff was
executed while writing these files. This template provides engineering CI
evidence only. It does not publish or mark a release stable, replace the real
Windows PC acceptance, or explain the previously observed intermittent PC
startup failure.

## Files and intended destinations

| Prepared file | Destination on the separate engineering branch |
|---|---|
| `windows-package-check.yml` | `.github/workflows/windows-package-check.yml` |
| `windows-package-check.json` | `.github/windows-package-check.json` |
| `verify-candidate-binding.mjs` | `scripts/windows/ci/verify-candidate-binding.mjs` |
| `print-sanitized-report.mjs` | `scripts/windows/ci/print-sanitized-report.mjs` |
| `full-package-smoke.mjs` | `scripts/windows/ci/full-package-smoke.mjs` |
| `Expand-CandidateOuter.ps1` | `scripts/windows/ci/Expand-CandidateOuter.ps1` |
| `native-module-probe.cjs` | `scripts/windows/ci/native-module-probe.cjs` |

The last three files are supplied and reviewed separately by the package-smoke
owner. Save the inactive stable-build workflow and fresh-identity handoff
engineering notes under `engineering/windows-qualification/`; those documents
are not native smoke inputs and do not trigger a repeat package check.

## Immutable candidate binding

The committed JSON uses the actual metadata supplied by the release coordinator:

- Repository: `SeanWu089/Codas-Router`, repository ID `1381092909`.
- Candidate source: `d53073494906f0804a189b1a37ca1bf932ac982e`.
- Candidate CI run: `45112363505`, attempt `1`.
- Actions artifact: `14789873723`; its exact name, size, SHA-256 digest, inner
  ZIP size/hash, and payload manifest hash are recorded in the JSON.

The preflight checks this binding with read-only GitHub metadata requests when
the workflow actually runs. It verifies the completed successful run, exact
source and repository IDs, expected candidate workflow, successful package job,
exact unexpired artifact metadata, and unchanged run attempt. It writes a receipt
containing the same 13 binding fields plus `verified:true`. It never selects an
artifact by a floating name, latest run, branch head, or search result.

The API artifact digest identifies the Actions service archive. The later
native controller separately verifies the downloaded five-file asset set and
the pinned inner ZIP and manifest bytes. A metadata check alone is not a
downloaded-byte verification.

## Execution order and scope

The workflow triggers only for pushes to `release/windows-package-check-*`
that change the native CI files or protected product/validation inputs. Changes
only to engineering notes or stored reports do not trigger it.

1. Disable automatic checkout line-ending conversion on the disposable runner,
   then check out the exact workflow SHA with complete Git history.
2. Select Node `22.23.3` and allocate canonical, isolated runner-temp paths.
3. Run the binding preflight. The candidate source must be an ancestor of the
   current checkout, all protected product/dependency/helper/test bytes must be
   unchanged, and tracked files must remain clean. The token is supplied only
   to this metadata step.
4. Restore original frozen transport objects using the already source-verified
   `restore-frozen-source.mjs` and its pinned local bundle. No remote source is
   fetched, no working-tree file is changed, and no branch head is reset.
5. Use `actions/download-artifact@v4` with the verified exact repository, run ID,
   artifact ID, and read-only token. The five candidate assets are placed in the
   isolated artifact directory.
6. Invoke the separate native controller with `--artifact-dir`, `--binding-file`,
   `--binding-receipt`, and `--report-dir`. This step has a 22-minute limit within
   a 30-minute job and receives no GitHub token. The controller owns its local
   state, child processes, bounded operations, and sanitized evidence.
7. Before upload, an `always()` step reads only `native-package-smoke.json` and
   `runtime-events.sanitized.json`, each at most 128 KiB. It applies another
   field allowlist and prints the completion phase, failure/stage/cleanup/child
   evidence, final supervisor state, and the final 30 sanitized events. It does
   not print raw messages, paths, environment, credentials, or command output.
   Each console JSON summary is capped at 64 KiB. Missing or oversized reports
   produce a fixed diagnostic instead of falling back to private/raw files.
8. Run the report upload with `always()` if the report directory was allocated.
   Only the sanitized report directory is uploaded. The downloaded candidate,
   private local profiles/state, credentials, and raw logs are not uploaded.

Workflow permissions are only `contents:read` and `actions:read`. No release API,
publication, Git ref mutation, enrollment, pairing, scheduler registration, or
existing physical-PC state is part of this workflow.

## Interpreting results

The intended controller exercises the actual shipped Windows Node, archive
extraction and dependency hashes, native module loading, isolated backend, and
authenticated loopback OAuth/MCP hostname command. Its report must state which
checks actually ran and passed, and that the environment was a disposable CI
Windows machine. A failed step remains a failed workflow; the report upload
does not convert failure into success.

Even a successful run does not establish other-device plugin access, an actual
SeansWPC installer/task/logon flow, physical-PC reconnect/repair/rollback, natural
wake or reboot, or resolution of an intermittent issue that CI did not reproduce.
Those claims still require their own real observations. There is no fixed
24-hour/8-hour publication gate under the user's latest daily-use instruction.

## Preparation validation

Preparation is limited to syntax and static integration checks, plus independent
read-only review. Do not describe these checks as a workflow execution or a
full-package smoke pass. No actual stable qualification report is supplied here.

## Official interfaces used

- [Get a workflow run](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)
- [List jobs for a workflow run](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)
- [Get an artifact](https://docs.github.com/en/rest/actions/artifacts#get-an-artifact)
- [Download from another workflow run](https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories)
