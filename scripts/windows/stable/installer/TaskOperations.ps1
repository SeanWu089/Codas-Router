. (Join-Path $PSScriptRoot 'Payload.ps1')

function Assert-CodasTaskXml([string]$Xml, $Record, [string]$InstallRoot) {
    Assert-CodasInstallation $Record $InstallRoot
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create((New-Object IO.StringReader($Xml)), $settings)
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    try { $document.Load($reader) } finally { $reader.Dispose() }
    $ns = New-Object Xml.XmlNamespaceManager($document.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $actions = @($document.SelectNodes('/t:Task/t:Actions/*', $ns))
    $principals = @($document.SelectNodes('/t:Task/t:Principals/t:Principal', $ns))
    $triggers = @($document.SelectNodes('/t:Task/t:Triggers/*', $ns))
    if ($actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec' -or $principals.Count -ne 1 -or
        $triggers.Count -ne 1 -or $triggers[0].LocalName -ne 'LogonTrigger') { throw 'Saved task has unexpected actions, principals, or triggers.' }
    $command = $actions[0].SelectSingleNode('t:Command', $ns)
    $arguments = $actions[0].SelectSingleNode('t:Arguments', $ns)
    $directory = $actions[0].SelectSingleNode('t:WorkingDirectory', $ns)
    $user = $principals[0].SelectSingleNode('t:UserId', $ns)
    $logon = $principals[0].SelectSingleNode('t:LogonType', $ns)
    $level = $principals[0].SelectSingleNode('t:RunLevel', $ns)
    $triggerUser = $triggers[0].SelectSingleNode('t:UserId', $ns)
    $description = $document.SelectSingleNode('/t:Task/t:RegistrationInfo/t:Description', $ns)
    if ($null -eq $command -or $null -eq $arguments -or $null -eq $directory -or $null -eq $user -or $null -eq $logon -or
        $null -eq $level -or $null -eq $triggerUser -or $null -eq $description -or
        $command.InnerText -ne (Get-CodasPowerShell) -or
        $arguments.InnerText -cne (Get-CodasTaskArguments $InstallRoot $Record.launcherPath $Record.launcherSha256 $Record.bootstrapManifestSha256) -or
        $directory.InnerText -ne $InstallRoot -or (ConvertTo-CodasSid $user.InnerText) -ne $Record.ownerSid -or
        (ConvertTo-CodasSid $triggerUser.InnerText) -ne $Record.ownerSid -or $logon.InnerText -ne 'InteractiveToken' -or
        $level.InnerText -ne 'LeastPrivilege' -or $description.InnerText -cne ('CodasStable installation ' + $Record.installId + ' at ' + $InstallRoot)) {
        throw 'Saved task XML does not match the exact owned launcher/principal.'
    }
    $context = $document.SelectSingleNode('/t:Task/t:Actions', $ns).GetAttribute('Context')
    if ($context -and $context -cne $principals[0].GetAttribute('id')) { throw 'Saved task principal context mismatch.' }
}

function Get-CodasEnabledIntent([string]$InstallRoot) {
    $path = Join-Path $InstallRoot 'state\enabled.json'
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    $value = Read-CodasJson $path
    if ($value.schemaVersion -ne 1 -or $value.enabled -isnot [bool]) { throw 'Invalid persisted enable/disable intent.' }
    return $value.enabled
}

function Register-CodasOwnedTask($Record, [string]$InstallRoot, $PreviousRecord = $null) {
    Assert-CodasInstallation $Record $InstallRoot
    $existing = Find-CodasTask $Record.taskName
    if ($null -ne $existing) {
        if ($null -eq $PreviousRecord) { throw 'Task name already exists; refusing to take ownership.' }
        $null = Get-CodasOwnedTask $PreviousRecord $InstallRoot
    }
    $action = New-ScheduledTaskAction -Execute (Get-CodasPowerShell) -Argument (Get-CodasTaskArguments $InstallRoot $Record.launcherPath $Record.launcherSha256 $Record.bootstrapManifestSha256) -WorkingDirectory $InstallRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Record.ownerSid
    $principal = New-ScheduledTaskPrincipal -UserId $Record.ownerSid -LogonType Interactive -RunLevel Limited
    # Supervisor owns unlimited bounded transient recovery; this is crash backup.
    # Terminal credentials stay blocked in supervisor state, not retried by restarts.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
    $parameters = @{
        TaskName = $Record.taskName; TaskPath = '\'; Action = $action; Trigger = $trigger
        Principal = $principal; Settings = $settings
        Description = ('CodasStable installation ' + $Record.installId + ' at ' + $InstallRoot)
        ErrorAction = 'Stop'
    }
    if ($null -ne $existing) { $parameters.Force = $true }
    Register-ScheduledTask @parameters | Out-Null
    $null = Get-CodasOwnedTask $Record $InstallRoot
}

function Get-CodasTaskSnapshot([string]$InstallRoot, $NewInstallation, [switch]$AllowDamagedPrevious) {
    $recordPath = Join-Path $InstallRoot 'installation.json'
    $pointer = Get-CodasPointer $InstallRoot -Optional
    $oldRecord = $null; $task = $null; $xml = $null; $receipt = $null
    if (Test-Path -LiteralPath $recordPath) {
        $oldRecord = Read-CodasJson $recordPath
        Assert-CodasInstallation $oldRecord $InstallRoot
        if ($null -eq $pointer) { throw 'Owned installation has no version pointer.' }
        if (-not $AllowDamagedPrevious) { $null = Test-CodasVersion $InstallRoot $pointer }
        $task = Get-CodasOwnedTask $oldRecord $InstallRoot -AllowMissing
        if ($null -ne $task) {
            $xml = Export-ScheduledTask -TaskName $oldRecord.taskName -TaskPath '\' -ErrorAction Stop
            Assert-CodasTaskXml $xml $oldRecord $InstallRoot
        }
        $receipt = Get-CodasOwnedReceipt $InstallRoot (Join-Path $InstallRoot 'state') -AllowStopped -AllowAbsentProcess:$AllowDamagedPrevious
        if ($null -ne $receipt -and $receipt.versionId -ne $pointer.versionId) {
            # Disabled activation preserves the last shutdown receipt while the
            # pointer advances. It is historical evidence only after a clean
            # stop AND a fresh absence check. Get-CodasOwnedReceipt above still
            # rejects any foreign/reused PID before reaching this exception.
            $cleanlyStopped = $receipt.status -in @('stopped', 'disabled') -and
                (Get-CodasProperty $receipt 'cleanShutdown' $false) -eq $true
            if (-not $cleanlyStopped -or $null -ne (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$receipt.pid) -ErrorAction Stop)) {
                throw 'Active process and previous pointer disagree.'
            }
        }
    } else {
        if ($null -ne $pointer) { throw 'Version pointer has no ownership record.' }
        if ($null -ne (Find-CodasTask $NewInstallation.taskName)) { throw 'Unowned task name collision.' }
    }
    return [pscustomobject]@{
        schemaVersion = 1; previousInstallation = $oldRecord; previousPointer = $pointer
        taskPresent = ($null -ne $task); taskXml = $xml
        taskEnabled = $(if ($null -ne $task) { [bool]$task.Settings.Enabled } else { $false })
        taskRunning = ($null -ne $task -and [string]$task.State -eq 'Running')
        runtimeInstanceId = $(if ($null -ne $receipt) { [string]$receipt.instanceId } else { $null })
        enabledIntent = Get-CodasEnabledIntent $InstallRoot
    }
}

function Stop-CodasPrevious([string]$InstallRoot, $Snapshot, $HealthyControlPointer = $null, [switch]$AllowAbsentProcess) {
    if ($null -eq $Snapshot.previousInstallation) { return }
    $task = Get-CodasOwnedTask $Snapshot.previousInstallation $InstallRoot -AllowMissing
    # The nonce/CIM validation is repeated immediately before graceful quiesce.
    Stop-CodasOwnedRuntime $InstallRoot (Join-Path $InstallRoot 'state') 20000 'quiesce' $HealthyControlPointer -AllowAbsentProcess:$AllowAbsentProcess
    if ($null -ne $task) {
        $null = Get-CodasOwnedTask $Snapshot.previousInstallation $InstallRoot
        Stop-ScheduledTask -TaskName $Snapshot.previousInstallation.taskName -TaskPath '\' -ErrorAction Stop
    }
}

function Restore-CodasPrevious([string]$InstallRoot, $Snapshot, $CandidateRecord, [bool]$TaskMutationAttempted) {
    $present = Find-CodasTask $CandidateRecord.taskName
    if ($null -ne $present) {
        $matches = $false
        try { $null = Get-CodasOwnedTask $CandidateRecord $InstallRoot; $matches = $true } catch { }
        if (-not $matches -and $null -ne $Snapshot.previousInstallation) {
            $null = Get-CodasOwnedTask $Snapshot.previousInstallation $InstallRoot
            $matches = $true
        }
        if (-not $matches) { throw 'Task was replaced by another actor; recovery blocked.' }
    }
    if ($Snapshot.taskPresent) {
        if ($null -eq $Snapshot.previousInstallation -or -not $Snapshot.taskXml) { throw 'Incomplete task snapshot.' }
        Assert-CodasInstallation $Snapshot.previousInstallation $InstallRoot
        if ($TaskMutationAttempted) {
            Assert-CodasTaskXml ([string]$Snapshot.taskXml) $Snapshot.previousInstallation $InstallRoot
            $parameters = @{ TaskName = $Snapshot.previousInstallation.taskName; TaskPath = '\'; Xml = [string]$Snapshot.taskXml; ErrorAction = 'Stop' }
            if ($null -ne $present) { $parameters.Force = $true }
            Register-ScheduledTask @parameters | Out-Null
        }
        $null = Get-CodasOwnedTask $Snapshot.previousInstallation $InstallRoot
        if ($Snapshot.taskEnabled) { Enable-ScheduledTask -TaskName $Snapshot.previousInstallation.taskName -TaskPath '\' -ErrorAction Stop | Out-Null }
        else { Disable-ScheduledTask -TaskName $Snapshot.previousInstallation.taskName -TaskPath '\' -ErrorAction Stop | Out-Null }
        if ($Snapshot.taskRunning) {
            Start-ScheduledTask -TaskName $Snapshot.previousInstallation.taskName -TaskPath '\' -ErrorAction Stop
            $probe = Invoke-CodasInstalledProbe $InstallRoot 180000
            if (-not $probe.passed) { throw 'Previous task restored but authenticated execution did not recover.' }
        }
    } elseif ($null -ne $present -and $TaskMutationAttempted) {
        $null = Get-CodasOwnedTask $CandidateRecord $InstallRoot
        Unregister-ScheduledTask -TaskName $CandidateRecord.taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
    }
}

function Invoke-CodasInstalledProbe([string]$InstallRoot, [int]$TimeoutMilliseconds = 180000) {
    $pointer = Get-CodasPointer $InstallRoot
    $version = Test-CodasVersion $InstallRoot $pointer
    $node = Join-Path $version 'payload\node\node.exe'
    $probe = Join-Path $version 'payload\runtime\probe.mjs'
    $runtimeIdentity = Read-CodasJson (Join-Path $InstallRoot 'state/installation.json')
    if (@($runtimeIdentity.allowedRoots).Count -lt 1) { throw 'Installed state has no explicit allowed workspace.' }
    $output = @(& $node $probe --install-root $InstallRoot --workspace $runtimeIdentity.allowedRoots[0] --timeout-ms $TimeoutMilliseconds)
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated local installation probe failed.' }
    $result = ($output -join "`n") | ConvertFrom-Json -ErrorAction Stop
    if ((Get-CodasProperty $result 'passed' $false) -ne $true -or (Get-CodasProperty $result 'authenticated' $false) -ne $true) {
        throw 'Local probe did not prove authenticated execution.'
    }
    return $result
}

function New-CodasTaskOperations([string]$InstallRoot, $NewInstallation, $HealthyControlPointer = $null, [switch]$AllowDamagedPrevious) {
    # GetNewClosure binds immutable invocation arguments for transaction hooks.
    return @{
        Capture = { Get-CodasTaskSnapshot $InstallRoot $NewInstallation -AllowDamagedPrevious:$AllowDamagedPrevious }.GetNewClosure()
        StopPrevious = { param($s) Stop-CodasPrevious $InstallRoot $s $HealthyControlPointer -AllowAbsentProcess:$AllowDamagedPrevious }.GetNewClosure()
        RegisterCandidate = {
            param($s)
            Register-CodasOwnedTask $NewInstallation $InstallRoot $s.previousInstallation
            if ($s.taskPresent -and -not $s.taskEnabled) { Disable-ScheduledTask -TaskName $NewInstallation.taskName -TaskPath '\' -ErrorAction Stop | Out-Null }
        }.GetNewClosure()
        StartAndProbe = {
            param($s)
            $null = Get-CodasOwnedTask $NewInstallation $InstallRoot
            if (-not $s.enabledIntent -or ($s.taskPresent -and -not $s.taskEnabled)) {
                return [pscustomobject]@{ passed = $true; authenticated = $false; preservedDisabled = $true; runtimeAcceptance = $false; remoteAcceptance = $false }
            }
            Start-ScheduledTask -TaskName $NewInstallation.taskName -TaskPath '\' -ErrorAction Stop
            return Invoke-CodasInstalledProbe $InstallRoot 180000
        }.GetNewClosure()
        StopCandidate = {
            param($s)
            $task = Find-CodasTask $NewInstallation.taskName
            $candidateTask = $false
            if ($null -ne $task) {
                try { $null = Get-CodasOwnedTask $NewInstallation $InstallRoot; $candidateTask = $true } catch {
                    if ($null -eq $s.previousInstallation) { throw }
                    $null = Get-CodasOwnedTask $s.previousInstallation $InstallRoot
                }
            }
            if ($candidateTask) {
                $receipt = Get-CodasOwnedReceipt $InstallRoot (Join-Path $InstallRoot 'state') -AllowStopped -AllowAbsentProcess:$AllowDamagedPrevious
                if ($null -ne $receipt -and $receipt.status -notin @('stopped','disabled') -and
                    $receipt.versionId -ne (Get-CodasPointer $InstallRoot).versionId) { throw 'Unexpected active version blocks candidate recovery.' }
                $recoveryControl = if ($null -ne $HealthyControlPointer) { $HealthyControlPointer } else { $s.previousPointer }
                Stop-CodasOwnedRuntime $InstallRoot (Join-Path $InstallRoot 'state') 20000 'quiesce' $recoveryControl -AllowAbsentProcess:$AllowDamagedPrevious
                $null = Get-CodasOwnedTask $NewInstallation $InstallRoot
                Stop-ScheduledTask -TaskName $NewInstallation.taskName -TaskPath '\' -ErrorAction Stop
            }
        }.GetNewClosure()
        RestorePrevious = { param($s, $changed) Restore-CodasPrevious $InstallRoot $s $NewInstallation $changed }.GetNewClosure()
    }
}
