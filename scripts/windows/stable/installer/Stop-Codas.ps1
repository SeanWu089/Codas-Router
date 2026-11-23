param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
$task = Get-CodasOwnedTask $record $InstallRoot -AllowMissing
# Persist the user's off intent even if later process/integrity evidence prevents
# us from proving a clean stop. This changes no identity or generation ledger.
$intentPath = Join-Path $InstallRoot 'state/enabled.json'
$intent = Read-CodasJson $intentPath
if ($intent.schemaVersion -ne 1 -or $intent.enabled -isnot [bool]) { throw 'Invalid enable/disable state.' }
Write-CodasJsonAtomic $intentPath @{schemaVersion=1;enabled=$false}
$version = Test-CodasVersion $InstallRoot (Get-CodasPointer $InstallRoot)
$state = Join-Path $InstallRoot 'state'
$receipt = Get-CodasOwnedReceipt $InstallRoot $state -AllowStopped
if ($null -ne $receipt -and $receipt.status -notin @('stopped', 'disabled')) {
    Stop-CodasOwnedRuntime $InstallRoot $state 20000 'stop'
} else {
    & (Join-Path $version 'payload\node\node.exe') (Join-Path $version 'payload\runtime\control.mjs') --install-root $InstallRoot --action stop | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not persist disabled state.' }
}
if ($null -ne $task) {
    $null = Get-CodasOwnedTask $record $InstallRoot
    Stop-ScheduledTask -TaskName $record.taskName -TaskPath '\' -ErrorAction Stop
}
[pscustomobject]@{ enabled=$false; stopped=$true; nextLogon='remains disabled until START' } | ConvertTo-Json -Compress
