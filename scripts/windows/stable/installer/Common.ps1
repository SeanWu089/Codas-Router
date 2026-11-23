# Shared installer primitives. No filesystem, task, or process mutation at import.
Set-StrictMode -Version 2.0

function Get-CodasProperty($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Assert-CodasVersionId([string]$VersionId) {
    if ($VersionId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' -or
        $VersionId.EndsWith('.') -or $VersionId -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
        throw 'Invalid release versionId.'
    }
}

function Get-CodasFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw 'An absolute local path is required.'
    }
    if ($Path.StartsWith('\\')) { throw 'UNC/device installation paths are not supported.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-CodasNoReparse([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('Reparse point is not permitted: ' + $cursor)
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Resolve-CodasContainedPath([string]$Root, [string]$Path) {
    $rootFull = Get-CodasFullPath $Root
    $pathFull = Get-CodasFullPath $Path
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path is not strictly contained in the installation root.'
    }
    return $pathFull
}

function Assert-CodasContained([string]$Root, [string]$Path) {
    $full = Resolve-CodasContainedPath $Root $Path
    Assert-CodasNoReparse $full
    return $full
}

function Get-CodasRelativePath([string]$Root, [string]$Path) {
    $full = Resolve-CodasContainedPath $Root $Path
    return $full.Substring((Get-CodasFullPath $Root).Length + 1).Replace('\', '/')
}

function Assert-CodasRelativeFile([string]$Path) {
    if (-not $Path -or $Path.Contains('\') -or $Path.Contains(':') -or $Path.StartsWith('/')) {
        throw 'Invalid relative manifest path.'
    }
    foreach ($segment in $Path.Split('/')) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..' -or
            $segment.TrimEnd(' ', '.') -ne $segment -or $segment -match '[<>"|?*\x00-\x1f]' -or
            $segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
            throw 'Invalid manifest path segment.'
        }
    }
}

function Read-CodasJson([string]$Path) {
    Assert-CodasNoReparse $Path
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
}

function Write-CodasBytesAtomic([string]$Path, [byte[]]$Bytes) {
    Assert-CodasNoReparse $Path
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'Atomic destination directory does not exist.' }
    $temporary = Join-Path $directory ('.codas-write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-CodasNoReparse $Path
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Write-CodasJsonAtomic([string]$Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 30 -Compress) + [Environment]::NewLine
    Write-CodasBytesAtomic $Path ((New-Object Text.UTF8Encoding($false)).GetBytes($json))
}

function Get-CodasFileBytesOrNull([string]$Path) {
    Assert-CodasNoReparse $Path
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return ,([IO.File]::ReadAllBytes($Path))
}

function Restore-CodasFile([string]$Path, $PreviousBytes) {
    Assert-CodasNoReparse $Path
    if ($null -eq $PreviousBytes) {
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
    } else { Write-CodasBytesAtomic $Path $PreviousBytes }
}

function Get-CodasPointer([string]$InstallRoot, [switch]$Optional) {
    $path = Join-Path $InstallRoot 'current.json'
    if ($Optional -and -not (Test-Path -LiteralPath $path)) { return $null }
    $pointer = Read-CodasJson $path
    if ($pointer.schemaVersion -ne 1) { throw 'Unknown installation pointer schema.' }
    Assert-CodasVersionId ([string]$pointer.versionId)
    if ([string]$pointer.manifestSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        [string]$pointer.transportRevision -notmatch '^[a-fA-F0-9]{40}$') { throw 'Invalid installation pointer pins.' }
    return $pointer
}

function Get-CodasVersionDirectory([string]$InstallRoot, [string]$VersionId) {
    Assert-CodasVersionId $VersionId
    return Assert-CodasContained $InstallRoot (Join-Path (Join-Path $InstallRoot 'versions') $VersionId)
}

function Get-CodasCurrentIdentity {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows installation requires Windows PowerShell and a Windows identity.' }
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function ConvertTo-CodasSid([string]$UserId) {
    if ($UserId -match '^S-1-[0-9-]+$') { return $UserId }
    return (New-Object Security.Principal.NTAccount($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-CodasPowerShell {
    return Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

function Quote-CodasArgument([string]$Argument) {
    if ($Argument.Contains('"') -or $Argument.Contains("`r") -or $Argument.Contains("`n")) {
        throw 'Unsafe command-line argument.'
    }
    return '"' + $Argument + '"'
}

function Get-CodasTaskArguments([string]$InstallRoot, [string]$LauncherPath, [string]$LauncherSha256, [string]$BootstrapManifestSha256) {
    if ($LauncherSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $BootstrapManifestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Task bootstrap pins are required.' }
    $launcherLiteral = "'" + $LauncherPath.Replace("'", "''") + "'"
    $rootLiteral = "'" + $InstallRoot.Replace("'", "''") + "'"
    $manifestLiteral = "'" + (Join-Path ([IO.Path]::GetDirectoryName($LauncherPath)) 'bootstrap-manifest.json').Replace("'", "''") + "'"
    # The task itself pins these files before running any installed .ps1 code.
    $command = '$ErrorActionPreference=''Stop''; $p=' + $launcherLiteral + '; $m=' + $manifestLiteral + '; '
    $command += 'foreach($f in @($p,$m)){ $x=$f; while($x){$i=Get-Item -LiteralPath $x -Force; if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ''Bootstrap reparse point''}; $x=[IO.Path]::GetDirectoryName($x)}}; '
    $command += 'if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne ''' + $LauncherSha256 + ''' -or (Get-FileHash -LiteralPath $m -Algorithm SHA256).Hash -ne ''' + $BootstrapManifestSha256 + '''){throw ''Bootstrap integrity failure''}; '
    $command += '& $p -InstallRoot ' + $rootLiteral + ' -BootstrapManifestSha256 ''' + $BootstrapManifestSha256 + '''; exit $LASTEXITCODE'
    return '-NoLogo -NoProfile -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
}

function Assert-CodasInstallation($Record, [string]$InstallRoot) {
    if ($Record.schemaVersion -ne 1 -or [string]$Record.installId -notmatch '^[a-f0-9]{32}$' -or
        [string]$Record.ownerSid -notmatch '^S-1-[0-9-]+$' -or
        [string]$Record.taskName -ne ('CodasStable-' + [string]$Record.installId)) { throw 'Invalid installation ownership record.' }
    if ((Get-CodasFullPath ([string]$Record.installRoot)) -ne (Get-CodasFullPath $InstallRoot)) { throw 'Installation ownership root mismatch.' }
    if ($Record.ownerSid -ne (Get-CodasCurrentIdentity)) { throw 'Installation belongs to a different Windows user.' }
    $launcher = Assert-CodasContained $InstallRoot ([string]$Record.launcherPath)
    if ([IO.Path]::GetFileName($launcher) -ne 'Start-Installed.ps1' -or [string]$Record.launcherSha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Invalid owned launcher.'
    }
    if ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ne $Record.launcherSha256) { throw 'Owned launcher changed.' }
    $bootstrap = Join-Path ([IO.Path]::GetDirectoryName($launcher)) 'bootstrap-manifest.json'
    if ([string](Get-CodasProperty $Record 'bootstrapManifestSha256' '') -notmatch '^[a-fA-F0-9]{64}$' -or
        (Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -ne $Record.bootstrapManifestSha256) { throw 'Bootstrap manifest pin mismatch.' }
    $manifest = Read-CodasJson $bootstrap
    if ($manifest.schemaVersion -ne 1) { throw 'Unknown bootstrap manifest schema.' }
    $entries = @($manifest.files) + @([pscustomobject]@{path='bootstrap-manifest.json';sha256=$Record.bootstrapManifestSha256})
    $null = Test-CodasFileManifest ([IO.Path]::GetDirectoryName($launcher)) $entries @('Common.ps1','Payload.ps1','TaskOperations.ps1','Start-Installed.ps1')
}

function Get-CodasOwnedTask($Record, [string]$InstallRoot, [switch]$AllowMissing) {
    Assert-CodasInstallation $Record $InstallRoot
    $tasks = @(Find-CodasTask ([string]$Record.taskName) | Where-Object { $null -ne $_ })
    if ($tasks.Count -eq 0 -and $AllowMissing) { return $null }
    if ($tasks.Count -ne 1) { throw 'Expected exactly one owned Codas task.' }
    $task = $tasks[0]
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne (Get-CodasPowerShell) -or
        $actions[0].Arguments -cne (Get-CodasTaskArguments $InstallRoot $Record.launcherPath $Record.launcherSha256 $Record.bootstrapManifestSha256) -or
        $actions[0].WorkingDirectory -ne $InstallRoot -or
        (ConvertTo-CodasSid $task.Principal.UserId) -ne $Record.ownerSid -or
        [string]$task.Principal.LogonType -ne 'Interactive' -or [string]$task.Principal.RunLevel -ne 'Limited' -or
        $task.Description -cne ('CodasStable installation ' + $Record.installId + ' at ' + $InstallRoot)) {
        throw 'Task ownership, action, principal, or working directory changed; refusing mutation.'
    }
    return $task
}

function Find-CodasTask([string]$TaskName) {
    try { return Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop }
    catch {
        if ([string]$_.CategoryInfo.Category -eq 'ObjectNotFound') { return $null }
        throw
    }
}

function Get-CodasOwnedReceipt([string]$InstallRoot, [string]$StateDirectory, [switch]$AllowStopped, [switch]$AllowAbsentProcess) {
    $state = Assert-CodasContained $InstallRoot $StateDirectory
    $receiptPath = Join-Path $state 'supervisor.json'
    if (-not (Test-Path -LiteralPath $receiptPath)) { return $null }
    $receipt = Read-CodasJson $receiptPath
    if ($receipt.schemaVersion -ne 1 -or [string]$receipt.instanceId -notmatch '^[a-fA-F0-9-]{36}$' -or $receipt.pid -le 0) { throw 'Invalid supervisor receipt.' }
    Assert-CodasVersionId ([string]$receipt.versionId)
    $version = Get-CodasVersionDirectory $InstallRoot $receipt.versionId
    $expectedNode = Join-Path $version 'payload\node\node.exe'
    if ([string]$receipt.nodePath -ne $expectedNode) { throw 'Supervisor receipt names a different executable.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$receipt.pid) -ErrorAction Stop
    if ($null -eq $process) {
        if ($AllowAbsentProcess) {
            $receipt | Add-Member -MemberType NoteProperty -Name processAbsent -Value $true -Force
            return $receipt
        }
        if ($AllowStopped -and $receipt.status -in @('stopped', 'disabled') -and (Get-CodasProperty $receipt 'cleanShutdown' $false) -eq $true) { return $receipt }
        throw 'Supervisor receipt has no matching live process; preserve evidence for explicit recovery.'
    }
    if ($receipt.status -in @('stopped','disabled') -and (Get-CodasProperty $receipt 'cleanShutdown' $false) -ne $true) { throw 'Previous shutdown is incomplete; preserve evidence before recovery.' }
    $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    if ($processOwner.ReturnValue -ne 0 -or $processOwner.Sid -ne (Get-CodasCurrentIdentity)) { throw 'Supervisor process belongs to a different Windows principal.' }
    $startDifference = [Math]::Abs((([datetime]$process.CreationDate).ToUniversalTime() - ([datetime]$receipt.startedAt).ToUniversalTime()).TotalSeconds)
    if ($process.ExecutablePath -ne $expectedNode -or $startDifference -gt 3) { throw 'Supervisor process identity mismatch.' }
    # Node constructs exactly this owned command vector; validate it against CIM.
    $arguments = @($receipt.args)
    if ($arguments.Count -lt 3 -or (($arguments.Count - 1) % 2) -ne 0 -or $arguments[0] -ne (Join-Path $version 'payload\runtime\supervisor.mjs')) { throw 'Supervisor command vector mismatch.' }
    $options = @{}
    for ($i = 1; $i -lt $arguments.Count; $i += 2) {
        $name = [string]$arguments[$i]
        if ($name -notin @('--install-root','--version-dir','--manifest-sha256','--state-dir') -or $options.ContainsKey($name)) { throw 'Supervisor option mismatch.' }
        $options[$name] = [string]$arguments[$i+1]
    }
    if (-not $options.ContainsKey('--install-root') -or (Get-CodasFullPath $options['--install-root']) -ne (Get-CodasFullPath $InstallRoot) -or
        ($options.ContainsKey('--state-dir') -and (Get-CodasFullPath $options['--state-dir']) -ne $state) -or
        (-not $options.ContainsKey('--state-dir') -and $state -ne (Join-Path $InstallRoot 'state')) -or
        ($options.ContainsKey('--version-dir') -and (Get-CodasFullPath $options['--version-dir']) -ne $version) -or
        ($options.ContainsKey('--manifest-sha256') -and $options['--manifest-sha256'] -notmatch '^[a-fA-F0-9]{64}$')) { throw 'Supervisor installation/state ownership mismatch.' }
    $expectedCommand = (Quote-CodasArgument $expectedNode) + ' ' + (($arguments | ForEach-Object { Quote-CodasArgument ([string]$_) }) -join ' ')
    # Node/CreateProcess may omit quotes on safe arguments. Compare using Windows parsing, not substring matches.
    $parsed = Split-CodasCommandLine ([string]$process.CommandLine)
    $expected = @($expectedNode) + $arguments
    if ($parsed.Count -ne $expected.Count) { throw 'Supervisor command-line length mismatch.' }
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ([string]$parsed[$i] -cne [string]$expected[$i]) { throw 'Supervisor command-line mismatch.' }
    }
    return $receipt
}

function Split-CodasCommandLine([string]$CommandLine) {
    if (-not ('CodasStableCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodasStableCommandLine {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s, out int n);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  public static string[] Parse(string s) {
    int n; IntPtr p = CommandLineToArgvW(s, out n);
    if (p == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try { string[] a = new string[n]; for (int i=0;i<n;i++) a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return a; }
    finally { LocalFree(p); }
  }
}
'@
    }
    return [CodasStableCommandLine]::Parse($CommandLine)
}

function Stop-CodasOwnedRuntime([string]$InstallRoot, [string]$StateDirectory, [int]$TimeoutMilliseconds = 20000, [string]$Action = 'quiesce', $HealthyControlPointer = $null, [switch]$AllowAbsentProcess) {
    $receipt = Get-CodasOwnedReceipt $InstallRoot $StateDirectory -AllowStopped -AllowAbsentProcess:$AllowAbsentProcess
    if ($null -eq $receipt) { return }
    if ((Get-CodasProperty $receipt 'processAbsent' $false) -eq $true) { return }
    if ($receipt.status -notin @('stopped', 'disabled')) {
        $controlPointer = if ($null -ne $HealthyControlPointer) { $HealthyControlPointer } else { Get-CodasPointer $InstallRoot }
        # Never execute an unverified on-disk Node/control merely to stop a live
        # process. Explicit recovery may use a different healthy retained version.
        $version = Test-CodasVersion $InstallRoot $controlPointer
        $node = Join-Path $version 'payload\node\node.exe'
        $control = Join-Path $version 'payload\runtime\control.mjs'
        & $node $control --install-root $InstallRoot --state-dir $StateDirectory --action $Action --instance-id $receipt.instanceId --timeout-ms $TimeoutMilliseconds | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Owned supervisor did not stop; rollback is blocked, no broad process kill was attempted.' }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$receipt.pid) -ErrorAction Stop
        $sameProcess = $null -ne $remaining -and $remaining.ExecutablePath -eq $receipt.nodePath -and
            [Math]::Abs((([datetime]$remaining.CreationDate).ToUniversalTime() - ([datetime]$receipt.startedAt).ToUniversalTime()).TotalSeconds) -le 3
        if (-not $sameProcess) { return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($sameProcess) {
        throw 'Supervisor stop receipt exists but the owned process is still alive; recovery blocked.'
    }
}
