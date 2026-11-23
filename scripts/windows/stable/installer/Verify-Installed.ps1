param([Parameter(Mandatory=$true)][string]$InstallRoot, [ValidateRange(1000,300000)][int]$TimeoutMilliseconds = 180000)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
$null = Get-CodasOwnedTask $record $InstallRoot
Invoke-CodasInstalledProbe $InstallRoot $TimeoutMilliseconds | ConvertTo-Json -Compress
