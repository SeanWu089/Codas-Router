param([Parameter(Mandatory=$true)][string]$InstallRoot, [string]$Router = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskOperations.ps1')
$InstallRoot = Get-CodasFullPath $InstallRoot
$record = Read-CodasJson (Join-Path $InstallRoot 'installation.json')
$null = Get-CodasOwnedTask $record $InstallRoot
$version = Test-CodasVersion $InstallRoot (Get-CodasPointer $InstallRoot)
if (Test-Path -LiteralPath (Join-Path $InstallRoot 'state/agent.json')) { throw 'This installation is already paired. Existing credentials and identity will not be overwritten.' }
if ([string]::IsNullOrWhiteSpace($Router)) { $Router = Read-Host 'Enter the intended Codas HTTPS ingress address' }
$uri = $null
if (-not [Uri]::TryCreate($Router, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or
    $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Use an HTTPS ingress origin without credentials, path, query, or fragment.' }
$secret = Read-Host 'Enter the one-time pairing token (hidden)' -AsSecureString
if ($secret.Length -eq 0) { throw 'Pairing cancelled: token is empty.' }
$node = Join-Path $version 'payload/node/node.exe'
$pair = Join-Path $version 'payload/runtime/pair.mjs'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $node
$start.Arguments = ((@($pair,'--install-root',$InstallRoot,'--router',$Router) | ForEach-Object { Quote-CodasArgument $_ }) -join ' ')
$start.WorkingDirectory = $version
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $start
$pointer = [IntPtr]::Zero
try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $process.StandardInput.WriteLine($plain)
    $process.StandardInput.Close()
    $plain = $null
    if (-not $process.WaitForExit(180000)) { throw 'Pairing is still running beyond its deadline; no existing identity was reset.' }
    $resultText = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Pairing failed. The runtime retains a sanitized error; credentials are not printed.' }
    $result = $resultText | ConvertFrom-Json -ErrorAction Stop
    if ((Get-CodasProperty $result 'paired' $false) -ne $true) { throw 'Pairing did not report success.' }
    [pscustomobject]@{ paired=$true; enabled=(Get-CodasEnabledIntent $InstallRoot); remoteAcceptance=$false; next='Run START.cmd, then verify an authorized folder from the other device.' } | ConvertTo-Json -Compress
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secret.Dispose()
    $process.Dispose()
}
