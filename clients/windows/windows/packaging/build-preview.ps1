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
    & $flutter build windows --release --target lib/windows_main.dart --build-name 0.1.1 --build-number 2
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
    $release = Join-Path $root 'build\windows\x64\runner\Release'
    foreach ($file in @('CodasDesktop.exe', 'flutter_windows.dll', 'data\flutter_assets')) {
        if (-not (Test-Path (Join-Path $release $file))) { throw "Incomplete build: $file" }
    }
    $iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($iscc) { $compiler = $iscc.Source } else {
        $compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    }
    if (-not (Test-Path $compiler)) { throw 'Install Inno Setup 6 on the authorized build machine before packaging.' }
    & $compiler (Join-Path $PSScriptRoot 'CodasDesktopPreview.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
    $installer = Join-Path $root 'dist\Codas-Desktop-Preview-0.1.1-x64-Setup.exe'
    if (-not (Test-Path $installer)) { throw 'Installer output missing' }
    $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path $installer -Leaf)" | Set-Content -Encoding ascii "$installer.sha256"
    Get-Item $installer
} finally { Pop-Location }
