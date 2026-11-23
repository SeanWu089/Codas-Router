param(
  [string]$RepoDir = (Join-Path $env:USERPROFILE "Codas-Router")
)

$ErrorActionPreference = "Stop"
# Keep explicit -RepoDir values; discover the old default only for existing installs.
$LegacyRepoDir = Join-Path $env:USERPROFILE "CodasSol-Router"
if (-not $PSBoundParameters.ContainsKey('RepoDir') -and -not (Test-Path $RepoDir) -and (Test-Path $LegacyRepoDir)) {
  $RepoDir = $LegacyRepoDir
}
$TaskName = "CodasSol Agent"
$Node = (Get-Command node -ErrorAction Stop).Source
$AgentScript = Join-Path $RepoDir "src\agent.js"

if (-not (Test-Path $AgentScript)) {
  throw "Codas-Router was not found at $RepoDir"
}

$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $AgentScript + '" run') -WorkingDirectory $RepoDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Connect this computer to Codas Router." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Codas Agent autostart task installed and started."

