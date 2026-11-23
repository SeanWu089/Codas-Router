param([Parameter(Mandatory=$true)][string]$LockFile)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stream = $null
try {
    if (-not [IO.Path]::IsPathRooted($LockFile)) { throw 'Absolute lock path required.' }
    $current = [IO.Path]::GetFullPath($LockFile)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse lock path rejected.' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    # OpenOrCreate never truncates existing contents. The OS handle, rather than
    # the persistent file's presence, proves exclusive ownership and releases
    # automatically on process death, logout, or reboot.
    $stream = [IO.File]::Open($LockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    [Console]::Out.WriteLine('{"acquired":true}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line -eq 'STOP') { break }
    }
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $code = $failure.HResult -band 0xffff
    if ($code -eq 32 -or $code -eq 33) {
        [Console]::Out.WriteLine('{"acquired":false,"reason":"LOCK_HELD"}')
        exit 73
    }
    [Console]::Out.WriteLine('{"acquired":false,"reason":"LOCK_OPEN_FAILED"}')
    exit 74
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
