[CmdletBinding()]
param(
  [switch]$InstallDesktop
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LauncherBat = Join-Path $PSScriptRoot 'start_dashboard_windows.bat'
$DistDirectory = Join-Path $ProjectRoot 'dist'
$ShortcutPath = Join-Path $DistDirectory 'ResumeJobs Launcher.lnk'

if (-not (Test-Path -LiteralPath $LauncherBat -PathType Leaf)) {
  Write-Host '缺少 Windows 启动脚本。/ The Windows launcher script is missing.' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Path $DistDirectory -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $env:ComSpec
$shortcut.Arguments = "/d /c `"`"$LauncherBat`"`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = 'Resume Jobs AI Assistant'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "已创建：$ShortcutPath" -ForegroundColor Green
Write-Host "Created: $ShortcutPath" -ForegroundColor Green

if ($InstallDesktop) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $desktopShortcut = Join-Path $desktop 'ResumeJobs Launcher.lnk'
  Copy-Item -LiteralPath $ShortcutPath -Destination $desktopShortcut -Force
  Write-Host "已安装桌面快捷方式：$desktopShortcut" -ForegroundColor Green
  Write-Host "Desktop shortcut installed: $desktopShortcut" -ForegroundColor Green
}
