[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodasSolStable'),
    [string[]]$AllowedRoot = @(),
    [ValidateRange(1024,65535)][int]$BackendPort = 28676,
    [Parameter(ParameterSetName='Install')][switch]$Repair,
    [Parameter(ParameterSetName='Verify',Mandatory=$true)][switch]$VerifyOnly,
    [Parameter(ParameterSetName='Stage',Mandatory=$true)][switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'Payload.ps1')
. (Join-Path $PSScriptRoot 'Transaction.ps1')
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')

function Copy-CodasPinnedFiles([string]$Source, [string]$Destination, $Files) {
    foreach ($entry in $Files) {
        $relative = [string]$entry.path
        Assert-CodasRelativeFile $relative
        $from = Assert-CodasContained $Source (Join-Path $Source $relative)
        $to = Assert-CodasContained $Destination (Join-Path $Destination $relative)
        if ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash -ne $entry.sha256) { throw ('Source changed while copying: ' + $relative) }
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($to)) -Force -ErrorAction Stop | Out-Null
        Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $entry.sha256) { throw ('Staged file mismatch: ' + $relative) }
    }
}

function Stage-CodasVersion([string]$Source, [string]$Root, $Release, [string]$RepairVersionId = '') {
    $stagedRelease = $Release
    if ($RepairVersionId) {
        Assert-CodasVersionId $RepairVersionId
        $stagedRelease = ($Release | ConvertTo-Json -Depth 30) | ConvertFrom-Json
        $stagedRelease | Add-Member -MemberType NoteProperty -Name repairOfVersionId -Value $Release.versionId -Force
        $stagedRelease | Add-Member -MemberType NoteProperty -Name sourceReleaseSha256 -Value (Get-FileHash -LiteralPath (Join-Path $Source 'release.json') -Algorithm SHA256).Hash -Force
        $stagedRelease.versionId = $RepairVersionId
    }
    $target = Get-CodasVersionDirectory $Root $stagedRelease.versionId
    $pointer = [pscustomobject]@{ schemaVersion=1; versionId=$stagedRelease.versionId; transportRevision=$Release.transportRevision; manifestSha256=$Release.manifestSha256 }
    if (Test-Path -LiteralPath $target) {
        $null = Test-CodasVersion $Root $pointer
        $existingRelease = Read-CodasRelease $target
        if ((Get-FileHash -LiteralPath (Join-Path $target 'release.json') -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath (Join-Path $Source 'release.json') -Algorithm SHA256).Hash) { throw 'Existing versionId has different release metadata; immutable versions cannot be overwritten.' }
        $null = Test-CodasInstallerFiles $target $existingRelease
        Write-CodasVerifiedVersion $Root $target $existingRelease
        return $target
    }
    $versions = Join-Path $Root 'versions'
    Assert-CodasNoReparse $versions
    New-Item -ItemType Directory -Path $versions -Force -ErrorAction Stop | Out-Null
    $stage = Join-Path $versions ('.stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $stage 'payload') -Force -ErrorAction Stop | Out-Null
    if ($null -ne (Get-CodasProperty $Release 'payloadArchive' $null)) {
        $null = Invoke-CodasPackedPayload $Source $Release (Join-Path $stage 'payload') $Root
    } else {
        Copy-CodasPayloadWithNode (Join-Path $Source 'payload') (Join-Path $Source 'payload-manifest.json') $Release.manifestSha256 (Join-Path $stage 'payload') $Root
    }
    Copy-CodasPinnedFiles $Source $stage $Release.installerFiles
    foreach ($name in @('payload-manifest.json', 'release.json')) {
        Copy-Item -LiteralPath (Join-Path $Source $name) -Destination (Join-Path $stage $name) -ErrorAction Stop
    }
    if ($RepairVersionId) {
        Copy-Item -LiteralPath (Join-Path $Source 'release.json') -Destination (Join-Path $stage 'source-release.json') -ErrorAction Stop
        Write-CodasJsonAtomic (Join-Path $stage 'release.json') $stagedRelease
    }
    $null = Test-CodasPayload (Join-Path $stage 'payload') (Join-Path $stage 'payload-manifest.json') $Release.manifestSha256 (Join-Path $stage 'installer/Payload-Tool.mjs')
    $null = Test-CodasInstallerFiles $stage $Release
    Assert-CodasNoReparse $target
    if (Test-Path -LiteralPath $target) { throw 'Version directory appeared while staging; refusing replacement.' }
    Move-Item -LiteralPath $stage -Destination $target -ErrorAction Stop
    Write-CodasVerifiedVersion $Root $target $stagedRelease
    return $target
}

function New-CodasBootstrap([string]$Root, [string]$VersionRoot, $Release) {
    $installerPins = @($Release.installerFiles | Where-Object { $_.path.StartsWith('installer/') } | Sort-Object path)
    $canonicalPins = ($installerPins | ForEach-Object { ([string]$_.path) + ':' + ([string]$_.sha256).ToLowerInvariant() }) -join "`n"
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalPins)))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $bin = Join-Path (Join-Path $Root 'bin') $digest
    $null = Assert-CodasContained $Root $bin
    if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin -Force -ErrorAction Stop | Out-Null }
    foreach ($entry in $installerPins) {
        $name = ([string]$entry.path).Substring('installer/'.Length)
        $source = Assert-CodasContained $VersionRoot (Join-Path $VersionRoot $entry.path)
        $destination = Assert-CodasContained $bin (Join-Path $bin $name)
        if (Test-Path -LiteralPath $destination) {
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Immutable bootstrap directory changed.' }
        } else {
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Bootstrap copy mismatch.' }
        }
    }
    $bootstrapFiles = @($installerPins | ForEach-Object { [pscustomobject]@{path=([string]$_.path).Substring('installer/'.Length);sha256=$_.sha256} })
    $bootstrapManifest = Join-Path $bin 'bootstrap-manifest.json'
    $bootstrapBytes = ConvertTo-CodasJsonBytes ([pscustomobject]@{schemaVersion=1;files=$bootstrapFiles})
    if (Test-Path -LiteralPath $bootstrapManifest) {
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($bootstrapManifest)) -cne [Convert]::ToBase64String($bootstrapBytes)) { throw 'Immutable bootstrap manifest changed.' }
    } else { Write-CodasBytesAtomic $bootstrapManifest $bootstrapBytes }
    return $bin
}

function Invoke-CodasInitializer([string]$Root, [string]$VersionRoot, [string]$ManifestPin, [string]$StateDirectory, [int]$Port, [string[]]$Roots) {
    $node = Join-Path $VersionRoot 'payload\node\node.exe'
    $arguments = @((Join-Path $VersionRoot 'payload\runtime\init-state.mjs'), '--install-root', $Root, '--version-dir', $VersionRoot,
        '--manifest-sha256', $ManifestPin, '--state-dir', $StateDirectory, '--backend-port', [string]$Port)
    foreach ($allowed in $Roots) { $arguments += @('--allowed-root', $allowed) }
    $output = @(& $node @arguments)
    if ($LASTEXITCODE -ne 0) { throw 'Isolated state initialization failed; existing state was not rolled back.' }
    # Runtime output must contain no credentials. Keep its diagnostic file in state.
}

function Test-CodasStagedRuntime([string]$Root, [string]$VersionRoot, [string]$ManifestPin, [string[]]$Roots) {
    $validation = Join-Path (Join-Path $Root 'validation') ([guid]::NewGuid().ToString('N'))
    $state = Join-Path $validation 'state'
    New-Item -ItemType Directory -Path $state -Force -ErrorAction Stop | Out-Null
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    Invoke-CodasInitializer $Root $VersionRoot $ManifestPin $state $port $Roots
    $node = Join-Path $VersionRoot 'payload\node\node.exe'
    $arguments = @((Join-Path $VersionRoot 'payload\runtime\supervisor.mjs'), '--install-root', $Root, '--version-dir', $VersionRoot,
        '--manifest-sha256', $ManifestPin, '--state-dir', $state)
    $commandArguments = ($arguments | ForEach-Object { Quote-CodasArgument ([string]$_) }) -join ' '
    $process = Start-Process -FilePath $node -ArgumentList $commandArguments -WorkingDirectory $VersionRoot -PassThru -WindowStyle Hidden -ErrorAction Stop
    $probePassed = $false
    try {
        $output = @(& $node (Join-Path $VersionRoot 'payload\runtime\probe.mjs') --install-root $Root --version-dir $VersionRoot --manifest-sha256 $ManifestPin --state-dir $state --workspace $Roots[0] --timeout-ms 180000)
        if ($LASTEXITCODE -ne 0) { throw 'Staged authenticated MCP probe failed.' }
        $result = ($output -join "`n") | ConvertFrom-Json -ErrorAction Stop
        if ($result.passed -ne $true -or $result.authenticated -ne $true) { throw 'Staged runtime has not proven authenticated execution.' }
        $probePassed = $true
        Write-CodasJsonAtomic (Join-Path $validation 'probe.json') $result
    } finally {
        # Only this isolated supervisor, authenticated by its process receipt, is stopped.
        if (Test-Path -LiteralPath (Join-Path $state 'supervisor.json')) {
            $stagedRelease = Read-CodasRelease $VersionRoot
            $controlPointer = [pscustomobject]@{schemaVersion=1;versionId=$stagedRelease.versionId;manifestSha256=$ManifestPin;transportRevision=$stagedRelease.transportRevision}
            Stop-CodasOwnedRuntime $Root $state 20000 'quiesce' $controlPointer
        } else {
            $process.Refresh()
            if (-not $process.HasExited) { throw ('Staged supervisor has no ownership receipt; installed runtime remains untouched. Review ' + $validation) }
        }
    }
    if (-not $probePassed) { throw 'Staged runtime verification did not complete.' }
    return $validation
}

function New-CodasEntrypoints([string]$Root, [string]$Bin, $OldRecord) {
    $files = @{}
    foreach ($name in @('START', 'STOP', 'STATUS', 'PAIR', 'ROLLBACK')) {
        $script = if ($name -eq 'ROLLBACK') { 'Rollback-CodasSol.ps1' } else { $name.Substring(0,1) + $name.Substring(1).ToLowerInvariant() + '-Codas.ps1' }
        $escapedScript = (Join-Path $Bin $script).Replace('%','%%')
        $content = '@echo off' + "`r`n" + 'setlocal DisableDelayedExpansion' + "`r`n" + '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "' + $escapedScript + '" -InstallRoot "%~dp0." %*' + "`r`n" + 'exit /b %errorlevel%' + "`r`n"
        $path = Join-Path $Root ($name + '.cmd')
        if (Test-Path -LiteralPath $path) {
            $pins = Get-CodasProperty $OldRecord 'entrypointHashes' $null
            $pin = Get-CodasProperty $pins ($name + '.cmd') ''
            if (-not $pin -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $pin) { throw 'Unrecognized or changed existing user entrypoint.' }
        }
        $files[$name + '.cmd'] = (New-Object Text.UTF8Encoding($false)).GetBytes($content)
    }
    return $files
}

$PackageRoot = Get-CodasFullPath $PackageRoot
Assert-CodasNoReparse $PackageRoot
if (-not $VerifyOnly -and -not $StageOnly) { Write-Host 'Checking the offline package. Existing Codas services remain untouched during this check.' }
$release = Read-CodasRelease $PackageRoot
$null = Test-CodasInstallerFiles $PackageRoot $release
if ($null -ne (Get-CodasProperty $release 'payloadArchive' $null)) { $payloadResult = Invoke-CodasPackedPayload $PackageRoot $release }
else { $payloadResult = Test-CodasPayload (Join-Path $PackageRoot 'payload') (Join-Path $PackageRoot 'payload-manifest.json') $release.manifestSha256 }
if ($VerifyOnly) {
    [pscustomobject]@{ verified=$true; versionId=$release.versionId; files=$payloadResult.files; installed=$false; runtimeAcceptance=$false } | ConvertTo-Json -Compress
    return
}
if ($env:OS -ne 'Windows_NT' -or $PSVersionTable.PSVersion.Major -lt 5) { throw 'Windows PowerShell 5.1 or newer is required for installation.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'This package requires Windows x64.' }
$InstallRoot = Get-CodasFullPath $InstallRoot
if ($InstallRoot -eq ([IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\')) -or $InstallRoot -eq (Get-CodasFullPath $env:USERPROFILE) -or
    $InstallRoot -eq (Get-CodasFullPath $env:LOCALAPPDATA)) { throw 'Choose a dedicated installation directory.' }
Assert-CodasNoReparse $InstallRoot
New-Item -ItemType Directory -Path $InstallRoot -Force -ErrorAction Stop | Out-Null
$lockPath = Join-Path $InstallRoot '.installer.lock'
Assert-CodasNoReparse $lockPath
$lock = $null
try {
    $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Assert-CodasNoIncompleteTransaction $InstallRoot
    $repairVersion = ''
    if ($Repair) {
        $current = Get-CodasPointer $InstallRoot
        if ($current.manifestSha256 -ne $release.manifestSha256 -or $current.transportRevision -ne $release.transportRevision) { throw 'Repair requires the exact installed payload manifest and transport revision; use a reviewed upgrade for different code.' }
        $owned = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
        Assert-CodasInstallation $owned $InstallRoot
        $null = Get-CodasOwnedTask $owned $InstallRoot -AllowMissing
        $baseName = [string]$release.versionId
        if ($baseName.Length -gt 63) { $baseName = $baseName.Substring(0,63).TrimEnd('.') }
        $repairVersion = $baseName + '-repair-' + [guid]::NewGuid().ToString('N').Substring(0,8)
    }
    if (-not $StageOnly) { Write-Host 'Preparing a separate version and preserving the previous installation.' }
    $versionRoot = Stage-CodasVersion $PackageRoot $InstallRoot $release $repairVersion
    $installedRelease = Read-CodasRelease $versionRoot
    if ($StageOnly) {
        [pscustomobject]@{ staged=$true; versionId=$release.versionId; versionRoot=$versionRoot; activated=$false; runtimeAcceptance=$false } | ConvertTo-Json -Compress
        return
    }
    $ownerSid = Get-CodasCurrentIdentity
    $oldRecord = $null
    $recordPath = Join-Path $InstallRoot 'installation.json'
    if (Test-Path -LiteralPath $recordPath) {
        $oldRecord = Read-CodasJson $recordPath
        Assert-CodasInstallation $oldRecord $InstallRoot
    }
    $stateDirectory = Join-Path $InstallRoot 'state'
    $runtimeIdentity = Join-Path $stateDirectory 'installation.json'
    if (Test-Path -LiteralPath $runtimeIdentity) {
        $retained = Read-CodasJson $runtimeIdentity
        if ($AllowedRoot.Count -eq 0) { $AllowedRoot = @($retained.allowedRoots) }
        if (-not $PSBoundParameters.ContainsKey('BackendPort')) { $BackendPort = [int]$retained.backendPort }
    }
    if ($AllowedRoot.Count -eq 0) {
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { throw 'Supply at least one explicit -AllowedRoot. No whole-profile default is granted.' }
        $selection = Read-Host 'Enter the existing folder Codas may access (for example C:\Work); leave empty to cancel'
        if ([string]::IsNullOrWhiteSpace($selection)) { throw 'Installation cancelled before activation.' }
        $AllowedRoot = @($selection.Trim().Trim('"'))
    }
    foreach ($allowed in $AllowedRoot) {
        $fullAllowed = Get-CodasFullPath $allowed
        Assert-CodasNoReparse $fullAllowed
        if (-not (Test-Path -LiteralPath $fullAllowed -PathType Container)) { throw 'AllowedRoot must be an existing normal directory.' }
    }
    $bin = New-CodasBootstrap $InstallRoot $versionRoot $release
    $launcher = Join-Path $bin 'Start-Installed.ps1'
    $installId = if ($null -ne $oldRecord) { [string]$oldRecord.installId } else { [guid]::NewGuid().ToString('N') }
    $newRecord = [pscustomobject]@{
        schemaVersion=1; installId=$installId; installRoot=$InstallRoot; ownerSid=$ownerSid
        taskName=('CodasStable-' + $installId); launcherPath=$launcher
        launcherSha256=(Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
        bootstrapManifestSha256=(Get-FileHash -LiteralPath (Join-Path $bin 'bootstrap-manifest.json') -Algorithm SHA256).Hash
        entrypointHashes=[pscustomobject]@{}
    }
    $entrypoints = New-CodasEntrypoints $InstallRoot $bin $oldRecord
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($name in $entrypoints.Keys) {
            $hash = ([BitConverter]::ToString($hasher.ComputeHash($entrypoints[$name]))).Replace('-', '')
            $newRecord.entrypointHashes | Add-Member -MemberType NoteProperty -Name $name -Value $hash
        }
    } finally { $hasher.Dispose() }
    # Validate task ownership before even starting the isolated staging probe.
    $null = Get-CodasTaskSnapshot $InstallRoot $newRecord -AllowDamagedPrevious:$Repair
    Write-Host 'Testing authenticated local access in an isolated workspace configuration.'
    $validation = Test-CodasStagedRuntime $InstallRoot $versionRoot $release.manifestSha256 $AllowedRoot
    Invoke-CodasInitializer $InstallRoot $versionRoot $release.manifestSha256 $stateDirectory $BackendPort $AllowedRoot
    $pointer = [pscustomobject]@{ schemaVersion=1; versionId=$installedRelease.versionId; manifestSha256=$release.manifestSha256; transportRevision=$release.transportRevision }
    $controlPointer = if ($Repair) { $pointer } else { $null }
    $operations = New-CodasTaskOperations $InstallRoot $newRecord $controlPointer -AllowDamagedPrevious:$Repair
    Write-Host 'Activating the verified version with rollback protection.'
    $outcome = Invoke-CodasActivation -InstallRoot $InstallRoot -NewPointer $pointer -NewInstallation $newRecord -Operations $operations -AdditionalFiles $entrypoints
    Write-Host ('Installed controls: ' + $InstallRoot)
    Write-Host 'START.cmd enables access; STOP.cmd stays off across login; STATUS.cmd shows state; PAIR.cmd connects the intended HTTPS ingress; ROLLBACK.cmd selects a verified retained version.'
    [pscustomobject]@{
        installed=$true; versionId=$installedRelease.versionId; installRoot=$InstallRoot; transaction=$outcome.transaction; repaired=[bool]$Repair
        stagedProbe=$validation; active=[bool]$outcome.probe.authenticated; remoteAcceptance=$false
        startup='Current user logon; startup before login is not provided.'
        pairing='Use explicit pairing to the intended HTTPS ingress. No existing production identity was imported.'
    } | ConvertTo-Json -Compress
} finally { if ($null -ne $lock) { $lock.Dispose() } }
