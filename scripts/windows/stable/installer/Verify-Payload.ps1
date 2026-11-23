param(
    [Parameter(Mandatory=$true)][string]$PayloadRoot,
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ManifestSha256
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Payload.ps1')
Test-CodasPayload $PayloadRoot $ManifestPath $ManifestSha256 | ConvertTo-Json -Compress
