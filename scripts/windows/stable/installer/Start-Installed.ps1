param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$BootstrapManifestSha256
)
$ErrorActionPreference = 'Stop'
# Task Scheduler has already verified this launcher and the manifest before
# executing it. Verify every imported helper before loading any installed code.
$bootstrapManifest = Join-Path $PSScriptRoot 'bootstrap-manifest.json'
if ((Get-FileHash -LiteralPath $bootstrapManifest -Algorithm SHA256).Hash -ne $BootstrapManifestSha256) { throw 'Bootstrap manifest changed.' }
$bootstrap = Get-Content -LiteralPath $bootstrapManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bootstrap.schemaVersion -ne 1) { throw 'Unknown bootstrap manifest schema.' }
$seen = @{}
foreach ($entry in $bootstrap.files) {
    $name = [string]$entry.path
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.(ps1|mjs)$' -or $seen.ContainsKey($name) -or
        [string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid bootstrap file pin.' }
    $file = Join-Path $PSScriptRoot $name
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw ('Bootstrap file changed: ' + $name) }
    $seen[$name] = $true
}
foreach ($name in @('Common.ps1','Payload.ps1','Start-Installed.ps1','Payload-Tool.mjs')) {
    if (-not $seen.ContainsKey($name)) { throw 'Required bootstrap file is missing.' }
}
. (Join-Path $PSScriptRoot 'Payload.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
try {
    $record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
    Assert-CodasInstallation $record $InstallRoot
    if ([string]$record.launcherPath -ne $PSCommandPath -or $record.bootstrapManifestSha256 -ne $BootstrapManifestSha256) { throw 'This is not the installation-owned launcher.' }
    $pointer = Get-CodasPointer $InstallRoot
    $version = Test-CodasVersion $InstallRoot $pointer
    & (Join-Path $version 'payload\node\node.exe') (Join-Path $version 'payload\runtime\supervisor.mjs') --install-root $InstallRoot
    exit $LASTEXITCODE
} catch {
    $failure = $_.Exception.Message
    try {
        $logs = Assert-CodasContained $InstallRoot (Join-Path $InstallRoot 'logs')
        New-Item -ItemType Directory -Path $logs -Force -ErrorAction Stop | Out-Null
        Write-CodasJsonAtomic (Join-Path $logs 'launcher-last-error.json') @{schemaVersion=1;time=[DateTime]::UtcNow.ToString('o');event='launcher-rejected';message=$failure}
    } catch { }
    Write-Error $failure
    exit 1
}
