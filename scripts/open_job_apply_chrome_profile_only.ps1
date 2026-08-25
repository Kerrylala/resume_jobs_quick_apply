$ErrorActionPreference = "Stop"

$ChromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProfilePath = Join-Path $ProjectRoot 'browser_profiles\job_apply_manual_profile_only'
$StartUrl = "chrome://extensions"

if (-not (Test-Path -LiteralPath $ChromeExe)) {
    Write-Error "Chrome executable not found: $ChromeExe"
    exit 2
}

if (-not (Test-Path -LiteralPath $ProfilePath)) {
    New-Item -ItemType Directory -Path $ProfilePath | Out-Null
}

$arguments = @(
    "--user-data-dir=`"$ProfilePath`"",
    "--no-first-run",
    "--disable-first-run-ui",
    $StartUrl
)

Write-Host "Launching Job Apply Chrome profile-only launcher"
Write-Host "Profile: $ProfilePath"
Write-Host "Opening: $StartUrl"
Start-Process -FilePath $ChromeExe -ArgumentList $arguments
