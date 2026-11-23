param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
$task = Get-CodasOwnedTask $record $InstallRoot -AllowMissing
$pointer = Get-CodasPointer $InstallRoot
$version = Test-CodasVersion $InstallRoot $pointer
& (Join-Path $version 'payload\node\node.exe') (Join-Path $version 'payload\runtime\control.mjs') --install-root $InstallRoot --action status
if ($LASTEXITCODE -ne 0) { throw 'Status inspection failed.' }
Write-Host ('Owned logon task: ' + $(if ($null -eq $task) { 'missing' } else { [string]$task.State }))
Write-Host 'Presence and a running task alone do not prove remote command execution.'
