param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
$null = Get-CodasOwnedTask $record $InstallRoot
$version = Test-CodasVersion $InstallRoot (Get-CodasPointer $InstallRoot)
& (Join-Path $version 'payload\node\node.exe') (Join-Path $version 'payload\runtime\control.mjs') --install-root $InstallRoot --action enable | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not enable this installation.' }
$null = Get-CodasOwnedTask $record $InstallRoot
Enable-ScheduledTask -TaskName $record.taskName -TaskPath '\' -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $record.taskName -TaskPath '\' -ErrorAction Stop
$probe = Invoke-CodasInstalledProbe $InstallRoot 180000
[pscustomobject]@{ enabled=$true; localAuthenticated=$probe.authenticated; hostname=$probe.hostname; remoteAcceptance=$false } | ConvertTo-Json -Compress
