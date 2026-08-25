[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8767
)

$ErrorActionPreference = 'Stop'
$SummaryUrl = "http://127.0.0.1:$Port/api/summary"

function Write-Bilingual {
  param([string]$Chinese, [string]$English, [ConsoleColor]$Color = [ConsoleColor]::Gray)
  Write-Host $Chinese -ForegroundColor $Color
  Write-Host $English -ForegroundColor $Color
}

try {
  $response = Invoke-WebRequest -Uri $SummaryUrl -UseBasicParsing -TimeoutSec 1
  $payload = $response.Content | ConvertFrom-Json
  $isResumeJobs = (
    $response.StatusCode -ge 200 -and
    $response.StatusCode -lt 300 -and
    $null -ne $payload.generated_at -and
    $null -ne $payload.jobs_shortlist_count
  )
} catch {
  $isResumeJobs = $false
}

if (-not $isResumeJobs) {
  Write-Bilingual `
    -Chinese "端口 $Port 上没有可确认的 Resume Jobs Dashboard；未停止任何进程。" `
    -English "No confirmed Resume Jobs Dashboard was found on port $Port; no process was stopped." `
    -Color Yellow
  exit 0
}

try {
  $connections = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction Stop)
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
  Write-Bilingual `
    -Chinese '无法安全识别 Dashboard 进程。请关闭启动器窗口来停止本次服务。' `
    -English 'The Dashboard process could not be identified safely. Close the launcher window to stop this session.' `
    -Color Yellow
  exit 1
}

$stopped = 0
foreach ($processId in $processIds) {
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if ($null -eq $processInfo -or $processInfo.CommandLine -notmatch 'dashboard[\\/]server\.mjs') {
      continue
    }
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    $stopped += 1
  } catch {
    # Continue so one stale PID does not expose a raw PowerShell error.
  }
}

if ($stopped -gt 0) {
  Write-Bilingual `
    -Chinese 'Resume Jobs Dashboard 已停止；没有删除或修改任何数据。' `
    -English 'Resume Jobs Dashboard stopped; no data was deleted or modified.' `
    -Color Green
  exit 0
}

Write-Bilingual `
  -Chinese 'Dashboard 可访问，但无法安全确认其进程归属；未停止任何进程。' `
  -English 'The Dashboard is reachable, but its process ownership could not be confirmed safely; no process was stopped.' `
  -Color Yellow
exit 1
