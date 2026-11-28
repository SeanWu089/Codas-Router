$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $root
try {
    $flutter = (Get-Command flutter -ErrorAction Stop).Source
    & $flutter pub get
    if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed' }
    & $flutter analyze
    if ($LASTEXITCODE -ne 0) { throw 'flutter analyze failed' }
    & $flutter test
    if ($LASTEXITCODE -ne 0) { throw 'flutter test failed' }
    & $flutter build windows --release --target lib/agent_desktop.dart --build-name 0.2.0 --build-number 8
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }

    $release = Join-Path $root 'build\windows\x64\runner\Release'
    foreach ($file in @('CodasWindowsAgent.exe', 'flutter_windows.dll', 'data\flutter_assets')) {
        if (-not (Test-Path (Join-Path $release $file))) { throw "Incomplete build: $file" }
    }
    $nodeHome = $env:CODAS_NODE_HOME
    if (-not $nodeHome -or -not (Test-Path (Join-Path $nodeHome 'node.exe'))) {
        throw 'Verified official Node distribution is required.'
    }
    $node = Join-Path $nodeHome 'node.exe'
    $npm = Join-Path $nodeHome 'npm.cmd'
    if ((Get-FileHash $node -Algorithm SHA256).Hash -ne '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e') { throw 'Node executable pin mismatch' }
    if ((& $node --version) -ne 'v22.23.3') { throw 'Unexpected Node version' }

    Push-Location (Join-Path $root 'runtime')
    try {
        & $npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Runtime dependencies failed' }
        & $node --test test/policy.test.mjs test/session.test.mjs test/proxy.test.mjs test/managed-backend.test.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Agent tests failed' }
    } finally { Pop-Location }

    # App-local Microsoft CRT from the installed VS toolchain's redistributable directory.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw 'Visual Studio CRT redistributables unavailable.' }
    # VS also provides toolset aliases such as v145, which are not System.Version values.
    # Rank only complete x64 CRT directories by the actual Microsoft runtime file version.
    $requiredCrt = @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')
    $crt = Get-ChildItem (Join-Path $vs 'VC\Redist\MSVC') -Directory | ForEach-Object {
        Get-ChildItem (Join-Path $_.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue
    } | Where-Object {
        $candidate = $_.FullName
        @($requiredCrt | Where-Object { -not (Test-Path -LiteralPath (Join-Path $candidate $_) -PathType Leaf) }).Count -eq 0
    } | Sort-Object -Property @{Expression={ (Get-Item -LiteralPath (Join-Path $_.FullName 'vcruntime140.dll')).VersionInfo.FileVersionRaw };Descending=$true},FullName | Select-Object -First 1
    if (-not $crt) { throw 'MSVC app-local CRT directory missing' }
    Copy-Item (Join-Path $crt.FullName '*.dll') $release -Force
    foreach ($name in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')) {
        if (-not (Test-Path (Join-Path $release $name))) { throw "Missing app-local CRT: $name" }
    }
    $runtime = Join-Path $release 'runtime'
    if (Test-Path $runtime) { throw 'Build runtime output already exists. Use a clean build.' }
    New-Item -ItemType Directory $runtime | Out-Null
    Copy-Item $node (Join-Path $runtime 'node.exe')
    Copy-Item (Join-Path $crt.FullName '*.dll') $runtime -Force
    Copy-Item (Join-Path $nodeHome 'LICENSE') (Join-Path $runtime 'NODE-LICENSE.txt')
    foreach ($file in @('desktop-worker.mjs', 'desktop-policy.mjs','managed-backend.mjs','backend-preload.mjs','session-generations.mjs','package.json','package-lock.json')) {
        Copy-Item (Join-Path $root "runtime\$file") $runtime
    }
    Copy-Item (Join-Path $root 'runtime\core') $runtime -Recurse
    New-Item -ItemType Directory (Join-Path $runtime 'node_modules') | Out-Null
    Copy-Item (Join-Path $root 'runtime\node_modules\jsonc-parser') (Join-Path $runtime 'node_modules') -Recurse
    $vendor = $env:CODAS_BACKEND_VENDOR
    if (-not $vendor -or -not (Test-Path (Join-Path $vendor 'devspace\node_modules\@waishnav\devspace\dist\cli.js'))) {
        throw 'Pinned offline DevSpace vendor payload is required.'
    }
    Copy-Item (Join-Path $vendor 'devspace') $runtime -Recurse
    if ((Get-FileHash (Join-Path $runtime 'devspace\node_modules\@waishnav\devspace\dist\cli.js') -Algorithm SHA256).Hash -ne '6028e1940c3fb728b270cb384f4f617b50fbf60e87783cf0c971d97b15c02ff5') { throw 'DevSpace CLI pin mismatch' }
    if ((Get-FileHash (Join-Path $runtime 'devspace\node_modules\better-sqlite3\build\Release\better_sqlite3.node') -Algorithm SHA256).Hash -ne 'c4b95a94a963258a9ef41b12fd3bb86f0b08a2ac5c5b499fe94de57a5443682d') { throw 'SQLite native binary pin mismatch' }
    if (Get-ChildItem $runtime -File | Where-Object { $_.Name -in @('agent.json','auth.json','profile.json') }) {
        throw 'Disallowed runtime state in package'
    }
    $manifest = [ordered]@{
        version = '0.2.0-rc.8'
        ingress = 'user-selected validated HTTPS origin; SSE only'
        coreSource = 'd67b37b069725b29c4bc829860c9bb33a590715f'
        coreAdapter = 'explicit local session grant, existing tool allowlist, stop guard and redirect rejection'
        nodeVersion = '22.23.3'
        devspaceBundled = $true
        devspaceVersion = '1.1.0-beta.4'
        devspaceProfile = 'Codas Workspace Lite'
        devspaceVendorSource = 'a9c8e888b3c82491e892b7d428f05660ae4717e4'
        privateState = 'state-v3'
        backendPort = 29676
        startupTask = $false
    }
    $manifest | ConvertTo-Json | Set-Content (Join-Path $runtime 'release-manifest.json') -Encoding UTF8

    $compiler = $env:CODAS_ISCC
    if (-not $compiler -or -not (Test-Path -LiteralPath $compiler)) { throw 'Pinned Inno Setup 7 compiler required' }
    $longest = Get-ChildItem -LiteralPath $release -File -Recurse | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 1
    Write-Host "Longest canonical input path: $($longest.FullName.Length) characters"
    & $compiler (Join-Path $PSScriptRoot 'CodasWindowsAgent.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
    $installer = Join-Path $root 'dist\Codas-Windows-Agent-0.2.0-rc.8-x64-Setup.exe'
    if (-not (Test-Path $installer)) { throw 'Installer output missing' }
    $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path $installer -Leaf)" | Set-Content -Encoding ascii "$installer.sha256"
    Get-Item $installer
} finally { Pop-Location }
