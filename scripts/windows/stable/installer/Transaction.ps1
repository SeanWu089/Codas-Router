. (Join-Path $PSScriptRoot 'Common.ps1')

# The hooks are internal adapters. Tests replace only task/process boundaries;
# production uses TaskOperations.ps1. No public installer parameter accepts code.
function Invoke-CodasActivation {
    param(
        [Parameter(Mandatory=$true)][string]$InstallRoot,
        [Parameter(Mandatory=$true)]$NewPointer,
        [Parameter(Mandatory=$true)]$NewInstallation,
        [Parameter(Mandatory=$true)][hashtable]$Operations,
        [hashtable]$AdditionalFiles = @{}
    )
    foreach ($name in @('Capture', 'StopPrevious', 'RegisterCandidate', 'StartAndProbe', 'StopCandidate', 'RestorePrevious')) {
        if (-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) { throw ('Missing transaction adapter: ' + $name) }
    }
    Assert-CodasNoReparse $InstallRoot
    $pointerPath = Join-Path $InstallRoot 'current.json'
    $installationPath = Join-Path $InstallRoot 'installation.json'
    $oldPointerBytes = Get-CodasFileBytesOrNull $pointerPath
    $oldInstallationBytes = Get-CodasFileBytesOrNull $installationPath
    $previousAdditional = @{}
    foreach ($name in $AdditionalFiles.Keys) {
        if ($name -notin @('START.cmd', 'STOP.cmd', 'STATUS.cmd', 'PAIR.cmd', 'ROLLBACK.cmd')) { throw 'Unexpected activation convenience file.' }
        $previousAdditional[$name] = Get-CodasFileBytesOrNull (Join-Path $InstallRoot $name)
    }
    # Capture validates live ownership before any task/process mutation.
    $snapshot = & $Operations.Capture
    $transactionRoot = Join-Path (Join-Path $InstallRoot 'transactions') ([guid]::NewGuid().ToString('N'))
    $null = Assert-CodasContained $InstallRoot $transactionRoot
    New-Item -ItemType Directory -Path $transactionRoot -Force -ErrorAction Stop | Out-Null
    if ($null -ne $oldPointerBytes) { Write-CodasBytesAtomic (Join-Path $transactionRoot 'previous-current.json') $oldPointerBytes }
    if ($null -ne $oldInstallationBytes) { Write-CodasBytesAtomic (Join-Path $transactionRoot 'previous-installation.json') $oldInstallationBytes }
    $additionalPresent = @{}
    foreach ($name in $previousAdditional.Keys) {
        $additionalPresent[$name] = ($null -ne $previousAdditional[$name])
        if ($null -ne $previousAdditional[$name]) { Write-CodasBytesAtomic (Join-Path $transactionRoot ('previous-' + $name)) $previousAdditional[$name] }
        Write-CodasBytesAtomic (Join-Path $transactionRoot ('candidate-' + $name)) $AdditionalFiles[$name]
    }
    Write-CodasJsonAtomic (Join-Path $transactionRoot 'task-snapshot.json') $snapshot
    $journalPath = Join-Path $transactionRoot 'journal.json'
    $journal = [ordered]@{
        schemaVersion = 1; transactionId = [IO.Path]::GetFileName($transactionRoot)
        startedAt = [DateTime]::UtcNow.ToString('o'); phase = 'prepared'; newPointer = $NewPointer; newInstallation = $NewInstallation
        previousPointerPresent = ($null -ne $oldPointerBytes); previousInstallationPresent = ($null -ne $oldInstallationBytes)
        additionalFiles = $additionalPresent
        taskSnapshotSha256 = (Get-FileHash -LiteralPath (Join-Path $transactionRoot 'task-snapshot.json') -Algorithm SHA256).Hash
        previousStopAttempted = $false; pointerMutationAttempted = $false; taskMutationAttempted = $false
        candidateStartAttempted = $false; rollbackStatus = 'not-needed'; failure = $null
    }
    Write-CodasJsonAtomic $journalPath $journal
    $stopAttempted = $false; $pointerAttempted = $false; $taskAttempted = $false; $startAttempted = $false
    try {
        $journal.phase = 'previous-stop-intent'; $journal.previousStopAttempted = $true
        Write-CodasJsonAtomic $journalPath $journal
        $stopAttempted = $true
        & $Operations.StopPrevious $snapshot
        $journal.phase = 'pointer-switch-intent'; $journal.pointerMutationAttempted = $true
        Write-CodasJsonAtomic $journalPath $journal
        $pointerAttempted = $true
        Write-CodasJsonAtomic $pointerPath $NewPointer
        Write-CodasJsonAtomic $installationPath $NewInstallation
        foreach ($name in $AdditionalFiles.Keys) { Write-CodasBytesAtomic (Join-Path $InstallRoot $name) $AdditionalFiles[$name] }
        $journal.phase = 'task-replace-intent'; $journal.taskMutationAttempted = $true
        Write-CodasJsonAtomic $journalPath $journal
        $taskAttempted = $true
        & $Operations.RegisterCandidate $snapshot
        $journal.phase = 'candidate-start-intent'; $journal.candidateStartAttempted = $true
        Write-CodasJsonAtomic $journalPath $journal
        $startAttempted = $true
        $probe = & $Operations.StartAndProbe $snapshot
        if ($null -eq $probe -or (Get-CodasProperty $probe 'passed' $false) -ne $true) { throw 'Candidate runtime probe did not pass.' }
        $journal.phase = 'committed'; $journal.completedAt = [DateTime]::UtcNow.ToString('o')
        Write-CodasJsonAtomic $journalPath $journal
        return [pscustomobject]@{ committed = $true; transaction = $transactionRoot; probe = $probe }
    } catch {
        $original = $_
        $journal.failure = $original.Exception.Message
        $journal.phase = 'rollback'; $journal.rollbackStatus = 'in-progress'
        $journalErrors = New-Object 'System.Collections.Generic.List[string]'
        try { Write-CodasJsonAtomic $journalPath $journal } catch { $journalErrors.Add('Could not record rollback intent.') }
        $rollbackFailure = $null
        try {
            # Do not repoint a still-running candidate; a blocked stop blocks recovery.
            if ($taskAttempted) { & $Operations.StopCandidate $snapshot }
            if ($pointerAttempted) {
                Assert-CodasRollbackFile $pointerPath $oldPointerBytes (ConvertTo-CodasJsonBytes $NewPointer)
                Assert-CodasRollbackFile $installationPath $oldInstallationBytes (ConvertTo-CodasJsonBytes $NewInstallation)
                foreach ($name in $AdditionalFiles.Keys) {
                    Assert-CodasRollbackFile (Join-Path $InstallRoot $name) $previousAdditional[$name] $AdditionalFiles[$name]
                }
                Restore-CodasFile $pointerPath $oldPointerBytes
                Restore-CodasFile $installationPath $oldInstallationBytes
                foreach ($name in $AdditionalFiles.Keys) { Restore-CodasFile (Join-Path $InstallRoot $name) $previousAdditional[$name] }
            }
            if ($stopAttempted -or $taskAttempted) { & $Operations.RestorePrevious $snapshot $taskAttempted }
            $journal.phase = 'rolled-back'; $journal.rollbackStatus = 'restored'
        } catch {
            $rollbackFailure = $_.Exception.Message
            $journal.phase = 'recovery-blocked'; $journal.rollbackStatus = 'blocked'; $journal.rollbackFailure = $rollbackFailure
        }
        try { Write-CodasJsonAtomic $journalPath $journal } catch { $journalErrors.Add('Could not record final recovery state.') }
        $suffix = ' Evidence: ' + $transactionRoot
        if ($null -ne $rollbackFailure -or $journalErrors.Count -gt 0) {
            throw ('Installation failed; recovery needs review. ' + $original.Exception.Message + ' ' + $rollbackFailure + ' ' + ($journalErrors -join ' ') + $suffix)
        }
        throw ('Installation failed; prior pointer/task state restored. ' + $original.Exception.Message + $suffix)
    }
}

function ConvertTo-CodasJsonBytes($Value) {
    return ,((New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 30 -Compress) + [Environment]::NewLine))
}

function Assert-CodasRollbackFile([string]$Path, $OldBytes, $NewBytes) {
    $current = Get-CodasFileBytesOrNull $Path
    $currentValue = if ($null -eq $current) { '<absent>' } else { [Convert]::ToBase64String($current) }
    $oldValue = if ($null -eq $OldBytes) { '<absent>' } else { [Convert]::ToBase64String($OldBytes) }
    $newValue = if ($null -eq $NewBytes) { '<absent>' } else { [Convert]::ToBase64String($NewBytes) }
    if ($currentValue -cne $oldValue -and $currentValue -cne $newValue) { throw 'Activation file changed outside this transaction; recovery blocked.' }
}

function Assert-CodasNoIncompleteTransaction([string]$InstallRoot) {
    $directory = Join-Path $InstallRoot 'transactions'
    if (-not (Test-Path -LiteralPath $directory)) { return }
    Assert-CodasNoReparse $directory
    foreach ($transaction in (Get-ChildItem -LiteralPath $directory -Directory -Force -ErrorAction Stop)) {
        Assert-CodasNoReparse $transaction.FullName
        $journalPath = Join-Path $transaction.FullName 'journal.json'
        if (-not (Test-Path -LiteralPath $journalPath)) { throw ('Incomplete preparation evidence needs review: ' + $transaction.FullName) }
        $journal = Read-CodasJson $journalPath
        if ($journal.schemaVersion -ne 1 -or $journal.phase -notin @('committed', 'rolled-back')) {
            throw ('Interrupted installation needs explicit recovery before retry: ' + $transaction.FullName)
        }
    }
}
