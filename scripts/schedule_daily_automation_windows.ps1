param(
  [string]$TaskName = 'ResumeJobsDailyAutomation',
  [string]$TaskTime = '09:00',
  [string]$WorkingDirectory = (Split-Path -Parent $PSScriptRoot),
  [string]$WslDistro = ''
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) {
  Write-Host "[info] $Message"
}

Write-Info "Task name: $TaskName"
Write-Info "Target working directory: $WorkingDirectory"

if (-not $WslDistro) {
  $wslList = & wsl.exe -l -v 2>$null
  if (-not $wslList) {
    Write-Host 'Could not detect WSL distros. Run: wsl -l -v'
    exit 1
  }
  Write-Host $wslList
  Write-Host ''
  Write-Host 'Please set -WslDistro to the Ubuntu distro name shown above, then rerun this script.'
  exit 1
}

if ($WorkingDirectory.Contains('"') -or $WslDistro.Contains('"')) {
  Write-Host 'The WSL distro and working directory cannot contain double-quote characters.'
  exit 1
}
$quotedWslDistro = '"' + $WslDistro + '"'
$quotedWorkingDirectory = '"' + $WorkingDirectory + '"'
$actionArgs = @('-d', $quotedWslDistro, '--cd', $quotedWorkingDirectory, '--', 'node', 'scripts/daily_automation_runner.mjs')
$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ($actionArgs -join ' ')
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($TaskTime, 'HH:mm', $null))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Host "Scheduled task '$TaskName' created for $TaskTime using WSL distro '$WslDistro'."
