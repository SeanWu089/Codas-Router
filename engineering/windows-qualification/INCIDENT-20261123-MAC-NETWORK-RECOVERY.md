# Mac network restoration and pending Windows reconnection — 2026-11-23

## Current status

The Mac network and router health checks recovered, but actual Codas access to
SEANSWPC remained unavailable. The Windows machine still uses the existing
legacy Desktop bridge; RC5 has not been installed there. A narrowly scoped
manual recovery of the existing Windows outbound task is being prepared for
the user because the Windows control channel is unavailable. No such restart
has been executed at this checkpoint.

## User-reported context

At approximately 13:37 Shanghai time, the user reported that disabling the
phone hotspot caused the Mac to lose network connectivity. Windows had been
reachable beforehand. After Mac internet access was restored, Windows did not
recover its connection. The exact outage and restoration timestamps were not
provided and must not be inferred from the later checks.

## Observed evidence

| Check | Observation |
| --- | --- |
| Device discovery at 05:37:41 UTC / 13:37:41 Shanghai | Mac online with `backendReachable:true`; SEANSWPC listed offline |
| Actual Mac workspace command during this investigation | `hostname` succeeded |
| Mac health checks at 05:38–05:39 UTC / 13:38–13:39 Shanghai | Both loopback `http://127.0.0.1:17676/_codassol/health` and public `https://codas.seansworkshop.site/_codassol/health` returned HTTP 200, `ok:true` and `backendReachable:true` |
| Existing bound Windows workspace | Actual `hostname` request failed with MCP `-32603 Internal error` |
| Fresh Windows workspace request | Opening Desktop with the explicit Windows device selection also failed with MCP `-32603 Internal error` |
| Mac production-path inspection | The workspace-open request was denied; the denial was not bypassed and the Mac was not restarted |

These checks establish recovered Mac/router availability and continued failure
of actual Windows access. An offline catalog entry does not establish that the
PC is powered off, asleep or disconnected from its own network. Mac health
alone does not prove that the Windows outbound bridge has reconnected.

## What remains unknown

The installed legacy Windows application's exact file hashes, current logs and
process/task state could not be read through the unavailable channel. Legacy
source permits a long reconnect backoff, which is a possible explanation to
investigate; there is no evidence yet that it caused this incident. Do not
attribute the failure to a specific timer, stale connection, Windows power
state or another root cause without the corresponding runtime observations.

The fixed RC5 source, candidate assembly and actual native CI package results
remain unchanged. RC5 is still an unpublished candidate draft, not a qualified
stable release. See [HANDOFF-20261123.md](HANDOFF-20261123.md) and
[RC5-CI-EVIDENCE-20261123.json](RC5-CI-EVIDENCE-20261123.json). Those results do
not identify the installed legacy bridge's behavior during this outage.

## Recovery and safe handoff

1. The coordinator is preparing a minimal user-run recovery targeting only the
   exact existing Windows outbound task. Record the command, whether it was
   actually executed and its observed result before claiming any recovery.
   Do not substitute an unverified task or a broad Node/process restart.
2. Preserve the current restored Windows bridge, shared dependencies, identity
   and frozen soak. Do not treat incident recovery as an RC5 installation,
   production migration, Mac restart or ingress replacement.
3. After access returns, use the explicitly selected SEANSWPC workspace for an
   actual authorized-folder operation and `hostname`. Record these results
   separately from device presence or HTTP health. Retrieve only the relevant
   legacy task/process/log evidence needed to explain the outage and recovery.
4. If manual recovery is needed, label it as manual. It does not satisfy the
   automatic-reconnection acceptance scenario below.

Recovery execution and its Windows workspace/command evidence are **pending**.

### Proposed single-task recovery (not executed)

The earlier 10:53 recovery record identified the existing outbound task as
`CodasSolOutboundSSE` (without spaces). Query that exact task, retain its state
and previous result, stop it, and require `Ready` before one start. If the name
is absent, ambiguous, disabled or the stop does not complete, retain the error
and stop; do not search for and restart a broader set of tasks. Do not invoke
`Start-Bridge.ps1`, re-enroll, change identity or repeatedly restart after failure.
The operator must run this on SEANSWPC because its remote control channel is down.

```powershell
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne 'SEANSWPC') { throw 'Run this on SEANSWPC.' }
$tasks = @(Get-ScheduledTask -TaskName 'CodasSolOutboundSSE')
if ($tasks.Count -ne 1) { throw 'Expected exactly one existing outbound task.' }
$t = $tasks[0]
$t | Select-Object TaskName, TaskPath, State
Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath | Select-Object LastRunTime, LastTaskResult
Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
Start-Sleep -Seconds 3
if ((Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath).State -ne 'Ready') { throw 'The task is not ready; no new instance was started.' }
Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath | Select-Object LastRunTime, LastTaskResult
```

Task status alone does not prove recovery. A successful fresh Codas workspace
operation and hostname are still required. This one-time manual recovery also
does not count as unattended reconnection acceptance.

## Essential remaining acceptance

The existing Mac network-interruption scenario must be accounted for: after
Mac connectivity is restored, Windows must reconnect automatically and support
a real Codas workspace command without manual intervention. Record what was
observed and the available timing evidence; do not invent an outage duration or
claim a successful unattended recovery from a manual task restart.

This requirement concerns recovery through the existing Mac/router deployment.
It does not add decentralization or core/ingress takeover to the Windows-client
scope. Actual SeansWPC package installation, task/logon behavior, stop/start,
repair/rollback and other-device Codas access also retain their existing pending
acceptance status.
