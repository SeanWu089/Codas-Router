. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
. (Join-Path $PSScriptRoot 'Transaction.ps1')

function Invoke-CodasRetainedRecovery([string]$InstallRoot, [string]$RetainedVersion) {
    Assert-CodasVersionId $RetainedVersion
    $current = Get-CodasPointer $InstallRoot
    if ($current.versionId -eq $RetainedVersion) { throw 'That version is already selected. Use the exact verified package with -Repair for damaged current files.' }
    # Verify the known-good version and its own retained verifier before reading
    # or executing any code from the damaged current payload.
    $healthyPointer = Get-CodasRetainedPointer $InstallRoot $RetainedVersion
    $record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
    Assert-CodasInstallation $record $InstallRoot
    $null = Get-CodasOwnedTask $record $InstallRoot -AllowMissing
    $operations = New-CodasTaskOperations $InstallRoot $record $healthyPointer -AllowDamagedPrevious
    $operations.RegisterCandidate = {
        param($snapshot)
        if ($snapshot.taskPresent) { $null = Get-CodasOwnedTask $record $InstallRoot }
        else { Register-CodasOwnedTask $record $InstallRoot $snapshot.previousInstallation }
    }.GetNewClosure()
    $outcome = Invoke-CodasActivation -InstallRoot $InstallRoot -NewPointer $healthyPointer -NewInstallation $record -Operations $operations
    return [pscustomobject]@{
        restored=$true;versionId=$RetainedVersion;transaction=$outcome.transaction
        active=[bool](Get-CodasProperty $outcome.probe 'authenticated' $false)
        stateRestoredFromBackup=$false;damagedVersionPreserved=$current.versionId;remoteAcceptance=$false
    }
}
