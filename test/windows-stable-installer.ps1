# Runs in an isolated temporary directory. No ScheduledTasks or live processes
# are changed: transaction adapters model the external boundary, with real files.
param([string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot), [string]$NodeExecutable = ((Get-Command node -ErrorAction Stop).Source))
$ErrorActionPreference = 'Stop'
$installer = Join-Path $RepositoryRoot 'scripts/windows/stable/installer'
. (Join-Path $installer 'Payload.ps1')
. (Join-Path $installer 'Transaction.ps1')
. (Join-Path $installer 'TaskOperations.ps1')
. (Join-Path $installer 'Recovery.ps1')
$script:passed = 0
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('codas-installer-fixtures-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop | Out-Null

function Assert-Fixture([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Fixture([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host ('PASS ' + $Name)
}
function Expect-FixtureFailure([scriptblock]$Body, [string]$Pattern) {
    $observed = $null
    try { & $Body | Out-Null } catch { $observed = $_.Exception.Message }
    if ($null -eq $observed -or ($Pattern -and $observed -notmatch $Pattern)) { throw ('Expected failure matching [' + $Pattern + '], got: ' + $observed) }
}
function New-FixtureNodeScript([string]$Name, [string]$Source) {
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid fixture script name.' }
    $scriptFile = Join-Path $temporaryRoot ($Name + '.cjs')
    # Windows PowerShell 5.1's native argument serializer can strip quotes from
    # JavaScript passed to node -e. A file keeps source bytes out of argv.
    [IO.File]::WriteAllText($scriptFile, $Source, (New-Object Text.UTF8Encoding($false)))
    return $scriptFile
}

function New-TransactionFixture([string]$Name) {
    $root = Join-Path $temporaryRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
    $oldPointer = [pscustomobject]@{ schemaVersion=1; versionId='v-old'; manifestSha256=('a' * 64); transportRevision=('b' * 40) }
    $newPointer = [pscustomobject]@{ schemaVersion=1; versionId='v-new'; manifestSha256=('c' * 64); transportRevision=('d' * 40) }
    $oldRecord = [pscustomobject]@{ schemaVersion=1; fixture='old' }
    $newRecord = [pscustomobject]@{ schemaVersion=1; fixture='new' }
    Write-CodasJsonAtomic (Join-Path $root 'current.json') $oldPointer
    Write-CodasJsonAtomic (Join-Path $root 'installation.json') $oldRecord
    Write-CodasJsonAtomic (Join-Path $root 'state/session-generation.json') @{generation=10}
    $originalEntry = [Text.Encoding]::UTF8.GetBytes('old-entrypoint')
    Write-CodasBytesAtomic (Join-Path $root 'START.cmd') $originalEntry
    $state = @{ root=$root; oldPointer=$oldPointer; newPointer=$newPointer; oldRecord=$oldRecord; newRecord=$newRecord
        owner='old'; running=$true; candidateRunning=$false; captureFailure=$false; stopFailure=$false
        registerFailure=$false; probeFailure=$false; quiesceFailure=$false; restoreFailure=$false; sabotagePointer=$false
        calls=(New-Object 'System.Collections.Generic.List[string]'); originalEntry=$originalEntry }
    $ops = @{
        Capture = {
            $state.calls.Add('capture')
            if ($state.captureFailure) { throw 'injected capture ownership failure' }
            return [pscustomobject]@{ schemaVersion=1; owner=$state.owner; running=$state.running }
        }.GetNewClosure()
        StopPrevious = {
            param($snapshot)
            $state.calls.Add('stop')
            $state.running=$false
            Write-CodasJsonAtomic (Join-Path $state.root 'state/session-generation.json') @{generation=11}
            if ($state.stopFailure) { throw 'injected partial stop failure' }
        }.GetNewClosure()
        RegisterCandidate = {
            param($snapshot)
            $state.calls.Add('register'); $state.owner='new'
            if ($state.registerFailure) { throw 'injected partial registration failure' }
        }.GetNewClosure()
        StartAndProbe = {
            param($snapshot)
            $state.calls.Add('probe'); $state.candidateRunning=$true
            if ($state.sabotagePointer) { Write-CodasJsonAtomic (Join-Path $state.root 'current.json') @{schemaVersion=1;versionId='someone-else'} }
            if ($state.probeFailure -or $state.sabotagePointer) { throw 'injected probe failure' }
            return [pscustomobject]@{passed=$true;authenticated=$true}
        }.GetNewClosure()
        StopCandidate = {
            param($snapshot)
            $state.calls.Add('quiesce')
            if ($state.quiesceFailure) { throw 'injected candidate would not stop' }
            $state.candidateRunning=$false
        }.GetNewClosure()
        RestorePrevious = {
            param($snapshot,$changed)
            $state.calls.Add('restore')
            if ($state.restoreFailure) { throw 'injected ownership changed during recovery' }
            $state.owner=$snapshot.owner; $state.running=$snapshot.running
        }.GetNewClosure()
    }
    return @{state=$state; operations=$ops}
}

function Invoke-FixtureTransaction($Fixture) {
    $s=$Fixture.state
    Invoke-CodasActivation -InstallRoot $s.root -NewPointer $s.newPointer -NewInstallation $s.newRecord -Operations $Fixture.operations -AdditionalFiles @{'START.cmd'=[Text.Encoding]::UTF8.GetBytes('new-entrypoint')}
}
function Assert-OldRestored($Fixture) {
    $s=$Fixture.state
    Assert-Fixture ((Read-CodasJson (Join-Path $s.root 'current.json')).versionId -eq 'v-old') 'Previous pointer was not restored.'
    Assert-Fixture ((Read-CodasJson (Join-Path $s.root 'installation.json')).fixture -eq 'old') 'Previous owner record was not restored.'
    Assert-Fixture ([IO.File]::ReadAllText((Join-Path $s.root 'START.cmd')) -eq 'old-entrypoint') 'Previous entrypoint was not restored.'
    Assert-Fixture ($s.owner -eq 'old' -and $s.running -and -not $s.candidateRunning) 'Task/runtime state did not recover.'
    Assert-Fixture ((Read-CodasJson (Join-Path $s.root 'state/session-generation.json')).generation -eq 11) 'Live generation ledger must never be rolled back.'
}

function New-PayloadFixture([string]$Name) {
    $root=Join-Path $temporaryRoot $Name
    $payload=Join-Path $root 'payload'
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    $required=@('node/node.exe','node/LICENSE','router/agent.js','router/agent-sse.js','router/package.json',
      'devspace/node_modules/@waishnav/devspace/dist/cli.js','devspace/node_modules/@waishnav/devspace/package.json',
      'devspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'runtime/supervisor.mjs','runtime/control.mjs','runtime/init-state.mjs','runtime/probe.mjs')
    $files=@()
    foreach($name in $required) {
        $path=Join-Path $payload $name
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($path)) -Force | Out-Null
        if ($name -eq 'node/node.exe') { Copy-Item -LiteralPath $NodeExecutable -Destination $path }
        else { [IO.File]::WriteAllText($path,'fixture:'+ $name) }
        $files+= [pscustomobject]@{path=$name;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
    }
    $manifest=Join-Path $root 'payload-manifest.json'
    Write-CodasJsonAtomic $manifest @{schemaVersion=1;files=$files;payloadToolSha256=(Get-FileHash -LiteralPath (Join-Path $installer 'Payload-Tool.mjs') -Algorithm SHA256).Hash}
    return @{root=$root;payload=$payload;manifest=$manifest;files=$files;pin=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash}
}

try {
    Test-Fixture 'activation commits only after authenticated probe' {
        $f=New-TransactionFixture 'success'
        $outcome=Invoke-FixtureTransaction $f
        Assert-Fixture $outcome.committed 'Transaction did not commit.'
        Assert-Fixture ((Read-CodasJson (Join-Path $f.state.root 'current.json')).versionId -eq 'v-new') 'New pointer missing.'
        Assert-Fixture ([IO.File]::ReadAllText((Join-Path $f.state.root 'START.cmd')) -eq 'new-entrypoint') 'New convenience entrypoint missing.'
        Assert-Fixture ((Read-CodasJson (Join-Path $outcome.transaction 'journal.json')).phase -eq 'committed') 'Committed evidence missing.'
    }
    Test-Fixture 'capture/ownership failure never stops prior runtime' {
        $f=New-TransactionFixture 'capture';$f.state.captureFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'capture ownership'
        Assert-Fixture ($f.state.calls.Count -eq 1 -and $f.state.running) 'Preparation failure touched runtime.'
    }
    Test-Fixture 'preparation directory failure leaves original task untouched' {
        $f=New-TransactionFixture 'preparation'
        [IO.File]::WriteAllText((Join-Path $f.state.root 'transactions'),'not-a-directory')
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} ''
        Assert-Fixture ($f.state.running -and -not $f.state.calls.Contains('stop')) 'Snapshot preparation stopped original runtime.'
    }
    Test-Fixture 'partial stop failure restores previous running task and preserves ledger' {
        $f=New-TransactionFixture 'stop';$f.state.stopFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'prior pointer/task state restored'
        Assert-OldRestored $f
    }
    Test-Fixture 'partially replaced task rolls back pointer and entrypoints' {
        $f=New-TransactionFixture 'registration';$f.state.registerFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'prior pointer/task state restored'
        Assert-OldRestored $f
    }
    Test-Fixture 'failed authenticated probe quiesces candidate before restoring old version' {
        $f=New-TransactionFixture 'probe';$f.state.probeFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'prior pointer/task state restored'
        Assert-OldRestored $f
        Assert-Fixture ($f.state.calls.IndexOf('quiesce') -lt $f.state.calls.IndexOf('restore')) 'Restored while candidate remained active.'
    }
    Test-Fixture 'unproven candidate stop blocks pointer rollback and prior restart' {
        $f=New-TransactionFixture 'blocked-stop';$f.state.probeFailure=$true;$f.state.quiesceFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'recovery needs review'
        Assert-Fixture ((Read-CodasJson (Join-Path $f.state.root 'current.json')).versionId -eq 'v-new') 'Repointed while candidate may be active.'
        Assert-Fixture (-not $f.state.calls.Contains('restore')) 'Started previous version during blocked stop.'
        Expect-FixtureFailure {Assert-CodasNoIncompleteTransaction $f.state.root} 'Interrupted installation'
    }
    Test-Fixture 'changed recovery ownership remains blocked and retains evidence' {
        $f=New-TransactionFixture 'blocked-restore';$f.state.probeFailure=$true;$f.state.restoreFailure=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'recovery needs review'
        Expect-FixtureFailure {Assert-CodasNoIncompleteTransaction $f.state.root} 'Interrupted installation'
    }
    Test-Fixture 'external pointer replacement is never overwritten during rollback' {
        $f=New-TransactionFixture 'external-pointer';$f.state.sabotagePointer=$true
        Expect-FixtureFailure {Invoke-FixtureTransaction $f} 'outside this transaction'
        Assert-Fixture ((Read-CodasJson (Join-Path $f.state.root 'current.json')).versionId -eq 'someone-else') 'Overwrote externally changed pointer.'
        Assert-Fixture (-not $f.state.calls.Contains('restore')) 'Restored task after external ownership change.'
    }
    Test-Fixture 'valid full payload passes without claiming runtime or provenance' {
        $f=New-PayloadFixture 'payload-valid'
        $r=Test-CodasPayload $f.payload $f.manifest $f.pin
        Assert-Fixture ($r.passed -and -not $r.runtimeAcceptance -and -not $r.provenanceVerified) 'Wrong verification claims.'
    }
    Test-Fixture 'corrupt payload file rejected' {
        $f=New-PayloadFixture 'payload-corrupt';[IO.File]::AppendAllText((Join-Path $f.payload 'node/node.exe'),'corrupt')
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest $f.pin} 'hash mismatch'
    }
    Test-Fixture 'missing native dependency rejected' {
        $f=New-PayloadFixture 'payload-missing';Remove-Item -LiteralPath (Join-Path $f.payload 'devspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest $f.pin} 'Missing payload'
    }
    Test-Fixture 'extra credential-like file rejected without reading its contents' {
        $f=New-PayloadFixture 'payload-extra';[IO.File]::WriteAllText((Join-Path $f.payload 'auth.json'),'fixture-only')
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest $f.pin} 'Unmanifested'
    }
    Test-Fixture 'wrong independently supplied manifest pin rejected' {
        $f=New-PayloadFixture 'payload-pin'
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest ('0' * 64)} 'Manifest hash mismatch'
    }
    Test-Fixture 'case-insensitive duplicate manifest paths rejected' {
        $f=New-PayloadFixture 'payload-duplicate'
        Write-CodasJsonAtomic $f.manifest @{schemaVersion=1;files=@($f.files)+@([pscustomobject]@{path='NODE/node.exe';sha256=('a' * 64)});payloadToolSha256=(Get-FileHash -LiteralPath (Join-Path $installer 'Payload-Tool.mjs') -Algorithm SHA256).Hash}
        $pin=(Get-FileHash -LiteralPath $f.manifest -Algorithm SHA256).Hash
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest $pin} 'Exactly one pinned node'
    }
    Test-Fixture 'manifest escape and Windows reserved aliases rejected' {
        foreach($name in @('../escape','node/../escape','node/CON.txt','node/file.','node/alternate:stream','/absolute','node\\file')) {
            Expect-FixtureFailure {Assert-CodasRelativeFile $name} 'Invalid'
        }
    }
    Test-Fixture 'version identifiers cannot select arbitrary pointer directories' {
        foreach($name in @('../other','C:\other','.', '..', 'CON', 'safe.', 'a/b', 'a b')) { Expect-FixtureFailure {Assert-CodasVersionId $name} 'Invalid' }
        Assert-CodasVersionId 'windows-0.2.0-rc.4-c1497ca'
    }
    Test-Fixture 'unlisted required runtime file rejected even if remaining files match' {
        $f=New-PayloadFixture 'payload-required'
        $files=@($f.files | Where-Object {$_.path -ne 'runtime/control.mjs'})
        Remove-Item -LiteralPath (Join-Path $f.payload 'runtime/control.mjs')
        Write-CodasJsonAtomic $f.manifest @{schemaVersion=1;files=$files;payloadToolSha256=(Get-FileHash -LiteralPath (Join-Path $installer 'Payload-Tool.mjs') -Algorithm SHA256).Hash}
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest ((Get-FileHash -LiteralPath $f.manifest -Algorithm SHA256).Hash)} 'Required dependency'
    }
    Test-Fixture 'long Windows payload paths are verified and staged through pinned Node' {
        $f=New-PayloadFixture 'payload-long-path'
        $relative = ((1..7 | ForEach-Object { 'deep-dependency-segment-12345678901234567890' }) -join '/') + '/native-fixture.txt'
        $longFile = Join-Path $f.payload $relative
        $nodeFixture = New-FixtureNodeScript 'long-path' 'const fs=require("node:fs"),p=require("node:path");fs.mkdirSync(p.dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],"long-path-fixture");'
        & $NodeExecutable $nodeFixture $longFile
        if ($LASTEXITCODE -ne 0) { throw 'Node could not create the deep-path fixture.' }
        $hasher=[Security.Cryptography.SHA256]::Create()
        try {$digest=([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes('long-path-fixture')))).Replace('-','')} finally {$hasher.Dispose()}
        $f.files += [pscustomobject]@{path=$relative;sha256=$digest}
        Write-CodasJsonAtomic $f.manifest @{schemaVersion=1;files=$f.files;payloadToolSha256=(Get-FileHash -LiteralPath (Join-Path $installer 'Payload-Tool.mjs') -Algorithm SHA256).Hash}
        $pin=(Get-FileHash -LiteralPath $f.manifest -Algorithm SHA256).Hash
        Assert-Fixture $((Test-CodasPayload $f.payload $f.manifest $pin).passed) 'Deep payload verify failed.'
        $install=Join-Path $f.root 'installed';New-Item -ItemType Directory -Path $install | Out-Null
        $destination=Join-Path $install 'versions/deep-fixture/payload'
        Copy-CodasPayloadWithNode $f.payload $f.manifest $pin $destination $install
        Assert-Fixture $((Test-CodasPayload $destination $f.manifest $pin).passed) 'Deep payload staging failed.'
        Assert-Fixture ($longFile.Length -gt 260) 'Fixture did not exceed the Windows classic path limit.'
    }
    Test-Fixture 'untrusted payload helper is rejected before execution' {
        $f=New-PayloadFixture 'payload-helper-pin'
        Write-CodasJsonAtomic $f.manifest @{schemaVersion=1;files=$f.files;payloadToolSha256=('0'*64)}
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest ((Get-FileHash -LiteralPath $f.manifest -Algorithm SHA256).Hash)} 'verifier does not match'
    }
    Test-Fixture 'junction/symlink payload directories are rejected without traversal' {
        $f=New-PayloadFixture 'payload-link'
        $target=Join-Path $f.root 'link-target';New-Item -ItemType Directory -Path $target | Out-Null
        $link=Join-Path $f.payload 'linked-directory'
        $nodeFixture = New-FixtureNodeScript 'reparse-link' 'const fs=require("node:fs");fs.symlinkSync(process.argv[2],process.argv[3],process.platform==="win32"?"junction":"dir");'
        & $NodeExecutable $nodeFixture $target $link
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated link fixture.' }
        Expect-FixtureFailure {Test-CodasPayload $f.payload $f.manifest $f.pin} 'Reparse/symbolic'
    }

    # Task boundary fixtures replace discovery and identity helpers only. They
    # never import or execute ScheduledTasks mutation commands.
    function Get-CodasCurrentIdentity { return 'S-1-5-21-100-200-300-1001' }
    function Get-CodasPowerShell { return (Join-Path $temporaryRoot 'system-powershell.exe') }
    function Find-CodasTask([string]$TaskName) { return $script:fixtureTask }
    $taskRoot=Join-Path $temporaryRoot 'task-fixture'
    $taskBin=Join-Path $taskRoot 'bin/pinned';New-Item -ItemType Directory -Path $taskBin -Force | Out-Null
    $pins=@()
    foreach($name in @('Common.ps1','Payload.ps1','TaskOperations.ps1','Start-Installed.ps1')) {
        [IO.File]::WriteAllText((Join-Path $taskBin $name),'fixture-only: '+$name)
        $pins += [pscustomobject]@{path=$name;sha256=(Get-FileHash -LiteralPath (Join-Path $taskBin $name) -Algorithm SHA256).Hash}
    }
    Write-CodasJsonAtomic (Join-Path $taskBin 'bootstrap-manifest.json') @{schemaVersion=1;files=$pins}
    $taskRecord=[pscustomobject]@{schemaVersion=1;installId=('a'*32);installRoot=$taskRoot;ownerSid=(Get-CodasCurrentIdentity);taskName=('CodasStable-'+('a'*32));launcherPath=(Join-Path $taskBin 'Start-Installed.ps1');launcherSha256=(Get-FileHash -LiteralPath (Join-Path $taskBin 'Start-Installed.ps1') -Algorithm SHA256).Hash;bootstrapManifestSha256=(Get-FileHash -LiteralPath (Join-Path $taskBin 'bootstrap-manifest.json') -Algorithm SHA256).Hash}
    function New-FixtureTask {
        return [pscustomobject]@{Actions=@([pscustomobject]@{Execute=(Get-CodasPowerShell);Arguments=(Get-CodasTaskArguments $taskRoot $taskRecord.launcherPath $taskRecord.launcherSha256 $taskRecord.bootstrapManifestSha256);WorkingDirectory=$taskRoot});Principal=[pscustomobject]@{UserId=$taskRecord.ownerSid;LogonType='Interactive';RunLevel='Limited'};Description=('CodasStable installation '+$taskRecord.installId+' at '+$taskRoot);Settings=[pscustomobject]@{Enabled=$true};State='Ready'}
    }
    Test-Fixture 'exact owned action/principal/workdir is recognized' {
        $script:fixtureTask=New-FixtureTask
        Assert-Fixture ($null -ne (Get-CodasOwnedTask $taskRecord $taskRoot)) 'Owned task rejected.'
    }
    Test-Fixture 'missing task is returned only when explicitly permitted' {
        $script:fixtureTask=$null
        Assert-Fixture ($null -eq (Get-CodasOwnedTask $taskRecord $taskRoot -AllowMissing)) 'Missing task did not remain missing.'
        Expect-FixtureFailure {Get-CodasOwnedTask $taskRecord $taskRoot} 'exactly one'
    }
    Test-Fixture 'task action replacement is not adopted' {
        $script:fixtureTask=New-FixtureTask;$script:fixtureTask.Actions[0].Arguments='unrelated'
        Expect-FixtureFailure {Get-CodasOwnedTask $taskRecord $taskRoot} 'ownership'
    }
    Test-Fixture 'task principal replacement is not adopted' {
        $script:fixtureTask=New-FixtureTask;$script:fixtureTask.Principal.UserId='S-1-5-18'
        Expect-FixtureFailure {Get-CodasOwnedTask $taskRecord $taskRoot} 'ownership'
    }
    Test-Fixture 'task working directory replacement is not adopted' {
        $script:fixtureTask=New-FixtureTask;$script:fixtureTask.Actions[0].WorkingDirectory=$temporaryRoot
        Expect-FixtureFailure {Get-CodasOwnedTask $taskRecord $taskRoot} 'ownership'
    }
    Test-Fixture 'tampered imported bootstrap code is rejected' {
        $script:fixtureTask=New-FixtureTask
        [IO.File]::AppendAllText((Join-Path $taskBin 'Common.ps1'),'changed')
        Expect-FixtureFailure {Get-CodasOwnedTask $taskRecord $taskRoot} 'hash mismatch'
    }
    [IO.File]::WriteAllText((Join-Path $taskBin 'Common.ps1'),'fixture-only: Common.ps1')
    function New-FixtureTaskXml {
        $command=[Security.SecurityElement]::Escape((Get-CodasPowerShell))
        $arguments=[Security.SecurityElement]::Escape((Get-CodasTaskArguments $taskRoot $taskRecord.launcherPath $taskRecord.launcherSha256 $taskRecord.bootstrapManifestSha256))
        $rootXml=[Security.SecurityElement]::Escape($taskRoot)
        $description=[Security.SecurityElement]::Escape(('CodasStable installation '+$taskRecord.installId+' at '+$taskRoot))
        return '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>'+ $description +'</Description></RegistrationInfo><Triggers><LogonTrigger><UserId>'+ $taskRecord.ownerSid +'</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>'+ $taskRecord.ownerSid +'</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Actions Context="Author"><Exec><Command>'+ $command +'</Command><Arguments>'+ $arguments +'</Arguments><WorkingDirectory>'+ $rootXml +'</WorkingDirectory></Exec></Actions></Task>'
    }
    Test-Fixture 'saved XML must match exact logon task before restoration' {
        Assert-CodasTaskXml (New-FixtureTaskXml) $taskRecord $taskRoot
    }
    Test-Fixture 'saved XML arbitrary command is refused before registration' {
        $xml=(New-FixtureTaskXml).Replace([Security.SecurityElement]::Escape((Get-CodasPowerShell)), 'unrelated.exe')
        Expect-FixtureFailure {Assert-CodasTaskXml $xml $taskRecord $taskRoot} 'does not match'
    }
    Test-Fixture 'saved XML additional actions cannot run during recovery' {
        $xml=(New-FixtureTaskXml).Replace('</Actions>','<Exec><Command>unrelated.exe</Command></Exec></Actions>')
        Expect-FixtureFailure {Assert-CodasTaskXml $xml $taskRecord $taskRoot} 'unexpected actions'
    }
    Test-Fixture 'saved XML external entities are prohibited' {
        $xml='<!DOCTYPE Task [<!ENTITY private SYSTEM "file:///must-not-be-opened">]>'+(New-FixtureTaskXml)
        Expect-FixtureFailure {Assert-CodasTaskXml $xml $taskRecord $taskRoot} 'DTD'
    }
    function Export-ScheduledTask { param($TaskName,$TaskPath) return New-FixtureTaskXml }
    function Stop-ScheduledTask { param($TaskName,$TaskPath) $script:fixtureTask.State='Ready' }
    $retainedFixture=New-PayloadFixture 'retained-source'
    $retainedRoot=Join-Path $taskRoot 'versions/v-healthy';New-Item -ItemType Directory -Path (Join-Path $retainedRoot 'installer') -Force | Out-Null
    Move-Item -LiteralPath $retainedFixture.payload -Destination (Join-Path $retainedRoot 'payload')
    $retainedTool=Join-Path $retainedRoot 'installer/Payload-Tool.mjs'
    [IO.File]::WriteAllText($retainedTool,([IO.File]::ReadAllText((Join-Path $installer 'Payload-Tool.mjs')) + "`n// retained verifier version fixture`n"))
    $retainedManifest=Join-Path $retainedRoot 'payload-manifest.json'
    Write-CodasJsonAtomic $retainedManifest @{schemaVersion=1;files=$retainedFixture.files;payloadToolSha256=(Get-FileHash -LiteralPath $retainedTool -Algorithm SHA256).Hash}
    $retainedRelease=[pscustomobject]@{schemaVersion=1;versionId='v-healthy';manifestSha256=(Get-FileHash -LiteralPath $retainedManifest -Algorithm SHA256).Hash;transportRevision=('a'*40)}
    Write-CodasJsonAtomic (Join-Path $retainedRoot 'release.json') $retainedRelease
    Write-CodasVerifiedVersion $taskRoot $retainedRoot $retainedRelease
    $damagedRoot=Join-Path $taskRoot 'versions/v-damaged';New-Item -ItemType Directory -Path $damagedRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $damagedRoot 'missing-node-evidence.txt'),'node.exe intentionally absent; must never be executed')
    $damagedPointer=[pscustomobject]@{schemaVersion=1;versionId='v-damaged';manifestSha256=('d'*64);transportRevision=('b'*40)}
    New-Item -ItemType Directory -Path (Join-Path $taskRoot 'state') -Force | Out-Null
    Write-CodasJsonAtomic (Join-Path $taskRoot 'state/enabled.json') @{schemaVersion=1;enabled=$false}
    Write-CodasJsonAtomic (Join-Path $taskRoot 'state/session-generation.json') @{generation=99}
    Write-CodasJsonAtomic (Join-Path $taskRoot 'installation.json') $taskRecord
    Write-CodasJsonAtomic (Join-Path $taskRoot 'current.json') $damagedPointer
    Test-Fixture 'retained version uses its own pinned verifier across installer changes' {
        $pointer=Get-CodasRetainedPointer $taskRoot 'v-healthy'
        Assert-Fixture ($pointer.manifestSha256 -eq $retainedRelease.manifestSha256) 'Retained verifier compatibility failed.'
        Assert-Fixture ((Get-FileHash -LiteralPath $retainedTool -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installer 'Payload-Tool.mjs') -Algorithm SHA256).Hash) 'Fixture did not use distinct verifier bytes.'
    }
    Test-Fixture 'damaged active payload recovers to verified retained version without identity reset' {
        $script:fixtureTask=New-FixtureTask
        $outcome=Invoke-CodasRetainedRecovery $taskRoot 'v-healthy'
        Assert-Fixture ($outcome.restored -and -not $outcome.active -and -not $outcome.stateRestoredFromBackup) 'Disabled recovery made an incorrect activation/state claim.'
        Assert-Fixture ((Read-CodasJson (Join-Path $taskRoot 'current.json')).versionId -eq 'v-healthy') 'Healthy version was not selected.'
        Assert-Fixture (-not (Read-CodasJson (Join-Path $taskRoot 'state/enabled.json')).enabled) 'Recovery silently enabled access.'
        Assert-Fixture ((Read-CodasJson (Join-Path $taskRoot 'state/session-generation.json')).generation -eq 99) 'Recovery reset the generation ledger.'
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $damagedRoot 'missing-node-evidence.txt')) 'Damaged version evidence was deleted.'
    }
    Test-Fixture 'retained recovery rejects replaced task before changing current pointer' {
        Write-CodasJsonAtomic (Join-Path $taskRoot 'current.json') $damagedPointer
        $script:fixtureTask=New-FixtureTask;$script:fixtureTask.Actions[0].Arguments='unrelated'
        Expect-FixtureFailure {Invoke-CodasRetainedRecovery $taskRoot 'v-healthy'} 'ownership'
        Assert-Fixture ((Read-CodasJson (Join-Path $taskRoot 'current.json')).versionId -eq 'v-damaged') 'Wrong task allowed a pointer switch.'
    }
    $script:fixtureTask=New-FixtureTask
    $receipt=[pscustomobject]@{schemaVersion=1;instanceId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';pid=12345;startedAt=[DateTime]::UtcNow.ToString('o');nodePath=(Join-Path $damagedRoot 'payload/node/node.exe');versionId='v-damaged';status='running';args=@((Join-Path $damagedRoot 'payload/runtime/supervisor.mjs'),'--install-root',$taskRoot)}
    Write-CodasJsonAtomic (Join-Path $taskRoot 'state/supervisor.json') $receipt
    function Get-CimInstance { param($ClassName,$Filter) return $script:fixtureProcess }
    function Invoke-CimMethod { param($InputObject,$MethodName) return [pscustomobject]@{ReturnValue=0;Sid=(Get-CodasCurrentIdentity)} }
    Test-Fixture 'PID reuse blocks retained recovery even when executable path matches' {
        $script:fixtureProcess=[pscustomobject]@{ExecutablePath=$receipt.nodePath;CreationDate=[DateTime]::UtcNow.AddHours(-1);CommandLine='unused'}
        Expect-FixtureFailure {Get-CodasOwnedReceipt $taskRoot (Join-Path $taskRoot 'state') -AllowStopped -AllowAbsentProcess} 'identity mismatch'
    }
    Test-Fixture 'absent previous owner is recoverable only in explicit recovery mode' {
        $script:fixtureProcess=$null
        Expect-FixtureFailure {Get-CodasOwnedReceipt $taskRoot (Join-Path $taskRoot 'state') -AllowStopped} 'no matching live process'
        $missing=Get-CodasOwnedReceipt $taskRoot (Join-Path $taskRoot 'state') -AllowStopped -AllowAbsentProcess
        Assert-Fixture $missing.processAbsent 'Explicit recovery did not preserve absent-owner evidence.'
    }
    $healthyPointer=Get-CodasRetainedPointer $taskRoot 'v-healthy'
    Write-CodasJsonAtomic (Join-Path $taskRoot 'current.json') $healthyPointer
    $receipt.status='stopped'
    $receipt | Add-Member -MemberType NoteProperty -Name cleanShutdown -Value $true -Force
    Write-CodasJsonAtomic (Join-Path $taskRoot 'state/supervisor.json') $receipt
    Test-Fixture 'clean stopped historical receipt permits another disabled activation' {
        $script:fixtureProcess=$null
        $snapshot=Get-CodasTaskSnapshot $taskRoot $taskRecord
        Assert-Fixture ($snapshot.previousPointer.versionId -eq 'v-healthy' -and $snapshot.runtimeInstanceId -eq $receipt.instanceId) 'Historical stop evidence was not retained with the selected healthy version.'
        Assert-Fixture (-not $snapshot.enabledIntent -and -not $snapshot.taskRunning) 'Historical receipt silently enabled or started the installation.'
        Assert-Fixture ((Read-CodasJson (Join-Path $taskRoot 'state/session-generation.json')).generation -eq 99) 'Repeated disabled preparation reset the generation ledger.'
    }
    Test-Fixture 'unclean historical receipt cannot bypass active version agreement' {
        $script:fixtureProcess=$null
        $receipt.cleanShutdown=$false
        Write-CodasJsonAtomic (Join-Path $taskRoot 'state/supervisor.json') $receipt
        Expect-FixtureFailure {Get-CodasTaskSnapshot $taskRoot $taskRecord -AllowDamagedPrevious} 'Active process and previous pointer disagree'
    }
    Test-Fixture 'active historical receipt cannot bypass active version agreement' {
        $script:fixtureProcess=$null
        $receipt.status='running';$receipt.cleanShutdown=$true
        Write-CodasJsonAtomic (Join-Path $taskRoot 'state/supervisor.json') $receipt
        Expect-FixtureFailure {Get-CodasTaskSnapshot $taskRoot $taskRecord -AllowDamagedPrevious} 'Active process and previous pointer disagree'
    }
    Test-Fixture 'clean stopped historical receipt still rejects a reused live PID' {
        $receipt.status='stopped';$receipt.cleanShutdown=$true
        Write-CodasJsonAtomic (Join-Path $taskRoot 'state/supervisor.json') $receipt
        $script:fixtureProcess=[pscustomobject]@{ExecutablePath=$receipt.nodePath;CreationDate=[DateTime]::UtcNow.AddHours(-1);CommandLine='unused'}
        Expect-FixtureFailure {Get-CodasTaskSnapshot $taskRoot $taskRecord -AllowDamagedPrevious} 'identity mismatch'
        Assert-Fixture ((Read-CodasJson (Join-Path $taskRoot 'current.json')).versionId -eq 'v-healthy') 'PID mismatch changed the current pointer.'
    }
    [pscustomobject]@{passed=$script:passed;failed=0;liveTasksTouched=$false;physicalWindowsAcceptance=$false;powerShell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress
} finally {
    # Only the random directory created by this process is removed.
    Assert-CodasNoReparse $temporaryRoot
    if (Test-Path -LiteralPath $temporaryRoot) {
        $nodeFixture = New-FixtureNodeScript 'cleanup' 'const fs=require("node:fs"),p=require("node:path"),os=require("node:os");const r=p.resolve(process.argv[2]);if(!/^codas-installer-fixtures-[a-f0-9]{32}$/.test(p.basename(r))||p.dirname(r).toLowerCase()!==p.resolve(os.tmpdir()).toLowerCase())throw Error("cleanup root mismatch");fs.rmSync(r,{recursive:true,force:true});'
        & $NodeExecutable $nodeFixture $temporaryRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the isolated installer fixture directory.' }
    }
}
