param(
    [Parameter(Mandatory=$true)][string]$ZipPath,
    [Parameter(Mandatory=$true)][string]$TargetDirectory
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $packageName = 'Codas-Windows-0.2.0-rc.5'
    $root = [IO.Path]::GetFullPath($TargetDirectory)
    if (-not [IO.Path]::IsPathRooted($ZipPath) -or -not [IO.Path]::IsPathRooted($TargetDirectory)) { throw 'Absolute paths are required.' }
    if (Test-Path -LiteralPath $root) { throw 'Outer extraction target must be new.' }
    $parent = Split-Path -Parent $root
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Canonical parent must already exist.' }
    $parentItem = Get-Item -LiteralPath $parent -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected parent refused.' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 100) { throw 'Unexpected outer archive size.' }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $members = @()
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name.Length -gt 180 -or -not $name.StartsWith($packageName + '/', [StringComparison]::Ordinal) -or $name.EndsWith('/') -or $name -match '[\\\x00-\x1f<>:"|?*]') { throw 'Unsafe outer archive path.' }
            if (-not $seen.Add($name)) { throw 'Duplicate outer archive path.' }
            foreach ($part in $name.Split('/')) {
                if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe outer archive component.' }
            }
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -ne 32768) { throw 'Only regular outer ZIP members are accepted.' }
            if ($entry.Length -lt 0 -or $entry.Length -gt 536870912) { throw 'Oversized outer archive member.' }
            $total += $entry.Length
            if ($total -gt 1073741824) { throw 'Oversized outer archive.' }
            $destination = [IO.Path]::GetFullPath((Join-Path $root ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            if (-not $destination.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Outer archive escaped target.' }
            $members += [PSCustomObject]@{ Entry=$entry; Destination=$destination }
        }
        foreach ($member in $members) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($member.Destination)) | Out-Null
            $incoming = $member.Entry.Open()
            try {
                $outgoing = [IO.File]::Open($member.Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $incoming.CopyTo($outgoing)
                    if ($outgoing.Length -ne $member.Entry.Length) { throw 'Outer ZIP member length mismatch.' }
                } finally { $outgoing.Dispose() }
            } finally { $incoming.Dispose() }
        }
        @{ passed=$true; files=$members.Count; bytes=$total } | ConvertTo-Json -Compress
    } finally { $zip.Dispose() }
} catch {
    [Console]::Error.WriteLine((@{ passed=$false; code='OUTER_ZIP_EXTRACTION_FAILED'; exceptionType=$_.Exception.GetType().Name } | ConvertTo-Json -Compress))
    exit 1
}
