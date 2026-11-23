# Windows dependency and packaging provenance

The Windows release builder reconstructs its dependency tree from exact upstream
archive bytes. It never copies an installed DevSpace directory, user profiles,
credentials, runtime state, or npm cache metadata into a release.

## Frozen inputs

- `windows-devspace-package-lock.json` preserves the captured npm v3 dependency
  lock. Its SHA-256 is pinned in `windows-runtime-pins.json`. No dependency
  versions are upgraded during packaging.
- `npm-integrity-supplement.json` supplies the three integrity values omitted
  from that original lock. Each was independently checked against the exact
  version's `dist.integrity` at `registry.npmjs.org` on 2026-11-23. The values
  match the previously captured local cache digests.
- `windows-runtime-pins.json` pins the Windows x64 Node 22.23.3 distribution,
  its executable and license, DevSpace 1.1.0-beta.4 and its CLI, and the official
  better-sqlite3 12.11.1 Node ABI 127 Windows x64 native prebuild.
- The transport source consists of the 22 original `src/*.js` Git objects from
  `c1497cac73c8d147dfcd74127018be470ae8a72a`. The builder reads those objects
  directly; changing a working-tree source file cannot change the bundled
  transport silently.

### Restoring the original Git objects after an API-based publication

The small `windows-frozen-transport.bundle` contains the exact original
`f8b3130` and `c1497ca` commits, with the already public
`0961b97ed8d2393f0aab57aa38593dc9968553b3` commit as its prerequisite. Its only
advertised ref is `refs/codas/frozen-windows-transport`. The SHA-256, exact commit
parents and trees are pinned in `windows-frozen-transport.json` and the restore
script. Original commit objects preserve their authors, timestamps and hashes;
they are not recreated through a publication API.

After a full-history checkout, run this once before tests or packaging:

```sh
node scripts/windows/stable/restore-frozen-source.mjs
```

The command verifies the bundle hash, fixed header/ref inventory and Git's
prerequisite check, imports only the fixed local hidden ref, then verifies the
exact original two-commit chain and `c1497ca` tree. It performs no network
request, checkout, source edit, branch update, tag import or global Git
configuration change. A conflicting hidden ref is refused rather than replaced.
Both CI workflows run it before any tests or build that read frozen Git blobs.
A shallow clone missing the public prerequisite must obtain the ordinary full
repository history first; the bootstrap does not fetch it automatically.

The Windows x64 selection contains 353 packages from 335 unique npm archives;
35 incompatible optional platform packages are excluded. All included archives
are integrity checked before parsing or extraction. No npm lifecycle scripts
execute. Node-pty and Koffi already contain/use their pinned Windows prebuilds;
better-sqlite3 receives its separately pinned official prebuild. Windows native
load and actual execution remain installation acceptance gates.

The three pinned agent-base/http-proxy-agent/https-proxy-agent archives repeat
an identical `dist/index.js` member using `package/./` and `package/` spelling.
Only byte-identical repetitions of the exact canonical name are collapsed and
reported in `dependency-provenance.json`. Conflicting bytes, case aliases,
links, traversal, alternate streams and special entries are rejected. Historical
DefinitelyTyped archive directory names are supported without changing files.

## Build commands

```sh
node scripts/windows/stable/build-package.mjs --prepare-dependencies \
  --cache ../windows-release-cache --official-only

node scripts/windows/stable/build-package.mjs --candidate \
  --cache ../windows-release-cache --offline \
  --output ../Codas-win-rc5
```

The cache is addressed by digest; a corrupt cache entry fails closed. The normal
build uses the mirror URL recorded by the lock and can fall back to the official
registry with the same required digest. `--official-only` is a per-command
download override and changes no system npm configuration. Build output must be
a new directory. `--unpacked` is available for engineering fixtures only.

## Compact offline distribution

The distributable directory has short outer paths: a pinned bootstrap Node,
installer scripts, `release.json`, `payload-manifest.json`, `payload-index.json`,
and one `payload.codas` archive. This prevents normal ZIP extraction from having
to create the tens of thousands of long dependency paths. The installer uses
the bundled Node to unpack into its own staging directory; it does not need
network downloads, npm, Python, PowerShell policy changes, or a system Node.

The archive begins with `CODAS-PAYLOAD-V1\n`. Its index describes contiguous
stored or raw-deflate members, each tied to the payload manifest's exact path,
size and SHA-256. The release metadata pins the whole archive and index. The
standalone extractor verifies all hashes, member bounds and exhaustive byte
coverage; it rejects duplicates, file/directory collisions, redirected paths,
nonempty targets and target paths outside the installer-owned root. It never
executes payload code. The ordinary payload verifier runs again after staging.

The complete dependency set is intentionally preserved, including large locked
provider executables. Package-size reduction requires a separate dependency
design and qualification; arbitrary pruning is not part of this release.

## Stable qualification is separate from building

`--candidate` is explicit and requires an `-rc.N` version label. It always emits
`qualification.stable: false`. A stable build requires `--stable`, a stable
version label and an exact passed qualification report. That report must match
the payload manifest, every frozen source hash and every installer/bootstrap
hash. It must separately establish:

- The explicit `windows-daily-use` policy, authorized by the user on 2026-11-23,
  with `fixedDurationRequired: false`. The user waived the previous mandatory
  24 awake hours / 8 idle hours. The report records actual cumulative awake and
  idle time as supplementary observations, without a minimum duration.
- At least 20 successful actual frozen-transport reconnect trials and two
  successful 85-second blackhole trials. The observed counters must establish
  one admitted SSE consumer at most, zero stale mutation executions, command
  failures, unexpected errors and manual interventions, with frozen source and
  measurement hashes verified. A duplicate-execution counter was not measured
  in the preserved evidence and is not invented as zero.
- Physical Windows execution of the actual packaged payload: PowerShell 5.1,
  native load, fresh install, installed probe, stop/start and task recovery,
  delayed-network readiness, missing/corrupt dependency refusal and repair,
  upgrade rollback, and actual Codas plugin access to an authorized folder.
  Preserved transport trials plus runtime readiness tests may establish
  delayed-network recovery; this does not require tampering with the PC's
  network settings.
- Explicit supplementary natural-wake and full-PC-reboot coverage. An
  unobserved wake has zero observed/recovered counts and a null recovery time.
  An untested reboot has `status: "not-tested"`. Neither is relabelled as
  passed or required to occur before release. If a wake was observed, every
  observed wake must have recovered within 90 seconds of awake time; known
  failures cannot be hidden by the duration waiver.

### Qualification report fields

The report uses `schemaVersion: 1`, `stable: true`, and `status: "passed"` only
after its actual required scenarios pass. It contains the exact
`transportRevision`, `manifestSha256`, `sourceFiles` and `installerFiles` copied
from the candidate that was tested. The remaining fields are:

| Field | Required content |
| --- | --- |
| `policy` | `{id: "windows-daily-use", authorizedOn: "2026-11-23", fixedDurationRequired: false}` |
| `transportTests` | `reconnectAttempts`, `reconnectPassed`, `blackholeAttempts`, `blackholePassed`, `blackholeDurationMs`, `maxAdmittedSseConsumers: 1`, zero `staleMutationsExecuted`, `commandFailures`, `unexpectedErrors`, `manualInterventions`, true `sourceHashesVerified` and `measurementHashesVerified`, plus nonempty `evidence` references |
| `installation` | `environment: "physical-windows"`, `actualPackageTested: true`, all gates below true, and nonempty `evidence` references |
| `soak` | `mode: "cumulative-awake"`, finite nonnegative `qualifiedAwakeMs` and `qualifiedIdleAwakeMs` (idle cannot exceed awake), and explicit `naturalWake` |
| `soak.naturalWake` | `coverage: "not-observed"`, both counts zero and `maxAwakeRecoveryMs: null`; or `coverage: "observed"`, matching positive `observedCount`/`recoveredCount`, finite `maxAwakeRecoveryMs` no greater than 90000, and nonempty `evidence` references |
| `fullPcReboot` | `{status: "not-tested", evidence: []}`; or `status: "passed"` with nonempty evidence for the actual reboot/login scenario |
| `evidence` | A nonempty inventory of `{name, sha256}`; every group reference must name an entry, with unique safe relative names and SHA-256 values |

Required installation gate names are `windowsPowerShell51`,
`payloadNativeSmoke`, `isolatedFreshInstall`, `installedProbe`,
`stopRestartRecovery`, `taskRestartRecovery`, `delayedNetworkRecovery`,
`dependencyLossEvidence`, `dependencyCorruptionRefused`, `dependencyRepair`,
`upgradeRollback`, and `authorizedFolderRemoteExecution`. Fixtures and CI
checks cannot substitute for the physical-Windows fields. A stable build
rechecks all current payload and installer bytes against the report, including
bootstrap files, before accepting it.

The builder cannot manufacture these outcomes and never sleeps, wakes, reboots
or changes power settings on a machine. A pending status snapshot is deliberately
insufficient for `--stable`. Archive/fixture tests are not Windows installation,
long-duration operation or user acceptance evidence.
