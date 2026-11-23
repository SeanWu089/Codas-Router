[CmdletBinding(DefaultParameterSetName='Retained')]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(ParameterSetName='Transaction',Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$TransactionId,
    [Parameter(ParameterSetName='Retained')][Alias('PreviousVersion')][string]$RetainedVersion
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Transaction.ps1')
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
. (Join-Path $PSScriptRoot 'Recovery.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$lockPath = Join-Path $InstallRoot '.installer.lock'
Assert-CodasNoReparse $lockPath
$lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    if ($PSCmdlet.ParameterSetName -eq 'Retained') {
        Assert-CodasNoIncompleteTransaction $InstallRoot
        if (-not $RetainedVersion) {
            $versions = Join-Path $InstallRoot 'verified-versions'
            Assert-CodasNoReparse $versions
            Write-Host 'Retained versions (selection still requires complete hash verification):'
            Get-ChildItem -LiteralPath $versions -Filter '*.json' -File | ForEach-Object { Write-Host ('  ' + $_.BaseName) }
            $RetainedVersion = Read-Host 'Enter a retained version ID to restore; leave empty to cancel'
            if (-not $RetainedVersion) { throw 'Recovery cancelled.' }
        }
        Invoke-CodasRetainedRecovery $InstallRoot $RetainedVersion | ConvertTo-Json -Compress
        return
    }
    $transaction = Assert-CodasContained $InstallRoot (Join-Path (Join-Path $InstallRoot 'transactions') $TransactionId)
    $journalPath = Join-Path $transaction 'journal.json'
    $journal = Read-CodasJson $journalPath
    if ($journal.schemaVersion -ne 1 -or $journal.transactionId -ne $TransactionId) { throw 'Invalid transaction evidence.' }
    if ($journal.phase -eq 'committed') { throw 'This command recovers interrupted/failed installation only; it does not downgrade a committed release.' }
    if ($journal.phase -eq 'rolled-back') {
        [pscustomobject]@{ restored=$true; alreadyRecovered=$true; transaction=$transaction } | ConvertTo-Json -Compress
        return
    }
    $snapshotPath = Join-Path $transaction 'task-snapshot.json'
    if ([string]$journal.taskSnapshotSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash -ne $journal.taskSnapshotSha256) { throw 'Task recovery snapshot changed.' }
    $snapshot = Read-CodasJson $snapshotPath
    if ($snapshot.schemaVersion -ne 1) { throw 'Invalid task recovery snapshot.' }
    Assert-CodasInstallation $journal.newInstallation $InstallRoot
    $healthyControl = $null
    if ($null -ne $snapshot.previousPointer) {
        $null = Test-CodasVersion $InstallRoot $snapshot.previousPointer
        $healthyControl = $snapshot.previousPointer
    }
    $operations = New-CodasTaskOperations $InstallRoot $journal.newInstallation $healthyControl -AllowDamagedPrevious
    $oldPointer = if ($journal.previousPointerPresent) { Get-CodasFileBytesOrNull (Join-Path $transaction 'previous-current.json') } else { $null }
    $oldRecord = if ($journal.previousInstallationPresent) { Get-CodasFileBytesOrNull (Join-Path $transaction 'previous-installation.json') } else { $null }
    if (($journal.previousPointerPresent -and $null -eq $oldPointer) -or ($journal.previousInstallationPresent -and $null -eq $oldRecord)) { throw 'Required recovery snapshot is missing.' }
    $pointerPath = Join-Path $InstallRoot 'current.json'
    $recordPath = Join-Path $InstallRoot 'installation.json'
    Assert-CodasRollbackFile $pointerPath $oldPointer (ConvertTo-CodasJsonBytes $journal.newPointer)
    Assert-CodasRollbackFile $recordPath $oldRecord (ConvertTo-CodasJsonBytes $journal.newInstallation)
    $additional = @{}
    foreach ($property in $journal.additionalFiles.PSObject.Properties) {
        $name = $property.Name
        if ($name -notin @('START.cmd','STOP.cmd','STATUS.cmd','PAIR.cmd','ROLLBACK.cmd')) { throw 'Unexpected activation recovery file.' }
        $prior = if ($property.Value) { Get-CodasFileBytesOrNull (Join-Path $transaction ('previous-' + $name)) } else { $null }
        $candidate = Get-CodasFileBytesOrNull (Join-Path $transaction ('candidate-' + $name))
        if ($null -eq $candidate -or ($property.Value -and $null -eq $prior)) { throw 'Activation file backup is incomplete.' }
        Assert-CodasRollbackFile (Join-Path $InstallRoot $name) $prior $candidate
        $additional[$name] = $prior
    }
    $journal.phase = 'rollback'; $journal.rollbackStatus = 'in-progress'
    Write-CodasJsonAtomic $journalPath $journal
    try {
        if ($journal.taskMutationAttempted) { & $operations.StopCandidate $snapshot }
        if ($journal.pointerMutationAttempted) {
            Restore-CodasFile $pointerPath $oldPointer
            Restore-CodasFile $recordPath $oldRecord
            foreach ($name in $additional.Keys) { Restore-CodasFile (Join-Path $InstallRoot $name) $additional[$name] }
        }
        if ($journal.previousStopAttempted -or $journal.taskMutationAttempted) { & $operations.RestorePrevious $snapshot ([bool]$journal.taskMutationAttempted) }
        $journal.phase = 'rolled-back'; $journal.rollbackStatus = 'restored'
        Write-CodasJsonAtomic $journalPath $journal
    } catch {
        $journal.phase = 'recovery-blocked'; $journal.rollbackStatus = 'blocked'
        $journal | Add-Member -MemberType NoteProperty -Name rollbackFailure -Value $_.Exception.Message -Force
        Write-CodasJsonAtomic $journalPath $journal
        throw
    }
    [pscustomobject]@{ restored=$true; transaction=$transaction; stateRolledBack=$false } | ConvertTo-Json -Compress
} finally { $lock.Dispose() }
