. (Join-Path $PSScriptRoot 'Common.ps1')

function Invoke-CodasPayloadNode([string]$Node, [string[]]$Arguments) {
    # PowerShell 5.1 represents native stderr as ErrorRecord objects. Capture it
    # without allowing that representation to skip the exit-code check.
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Node @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    $result = $null
    try { $result = $text | ConvertFrom-Json -ErrorAction Stop } catch { }
    if ($exitCode -ne 0 -or $null -eq $result -or (Get-CodasProperty $result 'passed' $false) -ne $true) {
        $detail = [string](Get-CodasProperty $result 'error' 'Native payload helper did not return verified success.')
        throw ('Payload helper rejected the package: ' + $detail)
    }
    return $result
}

function Test-CodasFileManifest([string]$Root, $Entries, [string[]]$Required = @()) {
    Assert-CodasNoReparse $Root
    $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { throw 'Payload root must be a directory.' }
    $rootFull = Get-CodasFullPath $Root
    $expected = @{}
    if (@($Entries).Count -eq 0) { throw 'Empty file manifest.' }
    foreach ($entry in $Entries) {
        $relative = [string](Get-CodasProperty $entry 'path' '')
        Assert-CodasRelativeFile $relative
        if ($expected.ContainsKey($relative)) { throw 'Duplicate case-insensitive manifest path.' }
        $digest = [string](Get-CodasProperty $entry 'sha256' '')
        if ($digest -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid manifest file digest.' }
        $null = Resolve-CodasContainedPath $rootFull (Join-Path $rootFull $relative)
        $expected[$relative] = $digest
    }
    foreach ($name in $Required) {
        if (-not $expected.ContainsKey($name)) { throw ('Required dependency absent from manifest: ' + $name) }
    }
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($rootFull)
    $observed = @{}
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        Assert-CodasNoReparse $directory
        foreach ($item in (Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in payload.' }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
            $relative = Get-CodasRelativePath $rootFull $item.FullName
            if (-not $expected.ContainsKey($relative)) { throw ('Unmanifested file: ' + $relative) }
            if ($observed.ContainsKey($relative)) { throw 'Duplicate observed file path.' }
            if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ne $expected[$relative]) {
                throw ('File hash mismatch: ' + $relative)
            }
            $observed[$relative] = $true
        }
    }
    foreach ($relative in $expected.Keys) {
        if (-not $observed.ContainsKey($relative)) { throw ('Missing payload file: ' + $relative) }
    }
    return $observed.Count
}

function Test-CodasPayload([string]$PayloadRoot, [string]$ManifestPath, [string]$ManifestSha256, [string]$ToolPath = '') {
    if ($ManifestSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'A separately pinned manifest digest is required.' }
    Assert-CodasNoReparse $ManifestPath
    if ((Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash -ne $ManifestSha256) { throw 'Manifest hash mismatch.' }
    $manifest = Read-CodasJson $ManifestPath
    if ((Get-CodasProperty $manifest 'schemaVersion' 0) -ne 1) { throw 'Unknown payload manifest schema.' }
    $node = Get-CodasVerifiedPayloadNode $PayloadRoot $manifest
    $tool = Get-CodasVerifiedPayloadTool $manifest $ToolPath
    return Invoke-CodasPayloadNode $node @($tool,'--mode','verify','--payload-root',$PayloadRoot,'--manifest',$ManifestPath,'--manifest-sha256',$ManifestSha256)
}

function Get-CodasVerifiedPayloadNode([string]$PayloadRoot, $Manifest) {
    $entries = @($Manifest.files | Where-Object { [string]$_.path -ieq 'node/node.exe' })
    if ($entries.Count -ne 1 -or [string]$entries[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Exactly one pinned node.exe is required.' }
    $node = Assert-CodasContained $PayloadRoot (Join-Path $PayloadRoot 'node/node.exe')
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $entries[0].sha256) { throw 'Bundled node.exe hash mismatch.' }
    return $node
}

function Get-CodasVerifiedPayloadTool($Manifest, [string]$ToolPath = '') {
    $tool = if ($ToolPath) { $ToolPath } else { Join-Path $PSScriptRoot 'Payload-Tool.mjs' }
    $pin = [string](Get-CodasProperty $Manifest 'payloadToolSha256' '')
    Assert-CodasNoReparse $tool
    if ($pin -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash -ne $pin) { throw 'Payload verifier does not match its independently pinned manifest.' }
    return $tool
}

function Copy-CodasPayloadWithNode([string]$SourcePayload, [string]$ManifestPath, [string]$ManifestSha256, [string]$Destination, [string]$InstallRoot) {
    Assert-CodasNoReparse $ManifestPath
    if ((Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash -ne $ManifestSha256) { throw 'Manifest changed before staging.' }
    $manifest = Read-CodasJson $ManifestPath
    $node = Get-CodasVerifiedPayloadNode $SourcePayload $manifest
    $tool = Get-CodasVerifiedPayloadTool $manifest
    $null = Invoke-CodasPayloadNode $node @($tool,'--mode','stage','--payload-root',$SourcePayload,'--manifest',$ManifestPath,'--manifest-sha256',$ManifestSha256,'--target',$Destination,'--install-root',$InstallRoot)
}

function Invoke-CodasPackedPayload([string]$PackageRoot, $Release, [string]$Destination = '', [string]$InstallRoot = '') {
    $archive = Get-CodasProperty $Release 'payloadArchive' $null
    if ($null -eq $archive -or $archive.format -ne 'codas-payload-v1') { throw 'Unsupported compact payload archive.' }
    $node = Join-Path $PackageRoot 'bootstrap/node.exe'
    $extractor = Join-Path $PackageRoot 'installer/Unpack-Payload.mjs'
    foreach ($name in @('bootstrap/node.exe','installer/Unpack-Payload.mjs')) {
        $pins = @($Release.installerFiles | Where-Object { $_.path -ieq $name })
        if ($pins.Count -ne 1 -or [string]$pins[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Compact package bootstrap pin is missing.' }
        $file = Assert-CodasContained $PackageRoot (Join-Path $PackageRoot $name)
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $pins[0].sha256) { throw 'Compact package bootstrap file changed.' }
    }
    $manifestPath = Join-Path $PackageRoot 'payload-manifest.json'
    if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne $Release.manifestSha256) { throw 'Compact payload manifest mismatch.' }
    $manifest = Read-CodasJson $manifestPath
    $nodePins = @($manifest.files | Where-Object { $_.path -ieq 'node/node.exe' })
    if ($nodePins.Count -ne 1 -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $nodePins[0].sha256) { throw 'Bootstrap and payload Node pins disagree.' }
    $null = Get-CodasVerifiedPayloadTool $manifest (Join-Path $PackageRoot 'installer/Payload-Tool.mjs')
    $arguments = @($extractor, '--package-root', $PackageRoot)
    if ([string]::IsNullOrWhiteSpace($Destination)) { $arguments += '--verify-only' }
    else {
        $null = Assert-CodasContained $InstallRoot $Destination
        $arguments += @('--target', $Destination, '--install-root', $InstallRoot)
    }
    return Invoke-CodasPayloadNode $node $arguments
}

function Read-CodasRelease([string]$PackageRoot) {
    $release = Read-CodasJson (Join-Path $PackageRoot 'release.json')
    if ((Get-CodasProperty $release 'schemaVersion' 0) -ne 1) { throw 'Unknown release metadata schema.' }
    Assert-CodasVersionId ([string]$release.versionId)
    if ([string]$release.transportRevision -notmatch '^[a-fA-F0-9]{40}$' -or
        [string]$release.manifestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid release pins.' }
    return $release
}

function Test-CodasInstallerFiles([string]$PackageRoot, $Release) {
    $entries = @(Get-CodasProperty $Release 'installerFiles' @())
    if ($entries.Count -eq 0) { throw 'Installer file pins are missing.' }
    $seen = @{}
    foreach ($entry in $entries) {
        $name = [string]$entry.path
        Assert-CodasRelativeFile $name
        if (($name -ne 'INSTALL.cmd' -and $name -ne 'bootstrap/node.exe' -and $name -ne 'bootstrap/LICENSE' -and -not $name.StartsWith('installer/', [StringComparison]::Ordinal)) -or
            $seen.ContainsKey($name)) { throw 'Invalid or duplicate installer file pin.' }
        $full = Assert-CodasContained $PackageRoot (Join-Path $PackageRoot $name)
        if ([string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
            (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ne $entry.sha256) { throw ('Installer file mismatch: ' + $name) }
        $seen[$name] = $true
    }
    foreach ($required in @('INSTALL.cmd', 'installer/Install-CodasSol.ps1', 'installer/Common.ps1', 'installer/Payload.ps1',
        'installer/Transaction.ps1', 'installer/Start-Installed.ps1', 'installer/Start-Codas.ps1',
        'installer/Stop-Codas.ps1', 'installer/Status-Codas.ps1', 'installer/Pair-Codas.ps1', 'installer/Verify-Installed.ps1')) {
        if (-not $seen.ContainsKey($required)) { throw ('Missing installer file pin: ' + $required) }
    }
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue((Join-Path $PackageRoot 'installer'))
    if (Test-Path -LiteralPath (Join-Path $PackageRoot 'bootstrap')) { $queue.Enqueue((Join-Path $PackageRoot 'bootstrap')) }
    while ($queue.Count -gt 0) {
        foreach ($item in (Get-ChildItem -LiteralPath $queue.Dequeue() -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer reparse point.' }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
            if (-not $seen.ContainsKey((Get-CodasRelativePath $PackageRoot $item.FullName))) { throw 'Unpinned installer file.' }
        }
    }
    return $true
}

function Test-CodasVersion([string]$InstallRoot, $Pointer) {
    $versionRoot = Get-CodasVersionDirectory $InstallRoot $Pointer.versionId
    $release = Read-CodasRelease $versionRoot
    if ($release.versionId -cne $Pointer.versionId -or $release.transportRevision -ne $Pointer.transportRevision -or
        $release.manifestSha256 -ne $Pointer.manifestSha256) { throw 'Pointer and version metadata disagree.' }
    $null = Test-CodasPayload (Join-Path $versionRoot 'payload') (Join-Path $versionRoot 'payload-manifest.json') $Pointer.manifestSha256 (Join-Path $versionRoot 'installer/Payload-Tool.mjs')
    return $versionRoot
}

function Write-CodasVerifiedVersion([string]$InstallRoot, [string]$VersionRoot, $Release) {
    $directory = Join-Path $InstallRoot 'verified-versions'
    Assert-CodasNoReparse $directory
    New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
    $recordPath = Join-Path $directory ($Release.versionId + '.json')
    $record = [pscustomobject]@{
        schemaVersion=1;versionId=$Release.versionId;manifestSha256=$Release.manifestSha256;transportRevision=$Release.transportRevision
        releaseSha256=(Get-FileHash -LiteralPath (Join-Path $VersionRoot 'release.json') -Algorithm SHA256).Hash
        payloadIntegrityVerified=$true;runtimeAcceptance=$false
    }
    if (Test-Path -LiteralPath $recordPath) {
        $old = Read-CodasJson $recordPath
        foreach ($name in @('schemaVersion','versionId','manifestSha256','transportRevision','releaseSha256')) {
            if ((Get-CodasProperty $old $name) -ne (Get-CodasProperty $record $name)) { throw 'Version pin record conflicts with retained evidence.' }
        }
    } else { Write-CodasJsonAtomic $recordPath $record }
}

function Get-CodasRetainedPointer([string]$InstallRoot, [string]$VersionId) {
    Assert-CodasVersionId $VersionId
    $record = Read-CodasJson (Join-Path (Join-Path $InstallRoot 'verified-versions') ($VersionId + '.json'))
    if ($record.schemaVersion -ne 1 -or $record.versionId -cne $VersionId -or [string]$record.manifestSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        [string]$record.transportRevision -notmatch '^[a-fA-F0-9]{40}$' -or [string]$record.releaseSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid retained version pin record.' }
    $version = Get-CodasVersionDirectory $InstallRoot $VersionId
    if ((Get-FileHash -LiteralPath (Join-Path $version 'release.json') -Algorithm SHA256).Hash -ne $record.releaseSha256) { throw 'Retained release metadata changed.' }
    $pointer = [pscustomobject]@{schemaVersion=1;versionId=$VersionId;manifestSha256=$record.manifestSha256;transportRevision=$record.transportRevision}
    $null = Test-CodasVersion $InstallRoot $pointer
    return $pointer
}
