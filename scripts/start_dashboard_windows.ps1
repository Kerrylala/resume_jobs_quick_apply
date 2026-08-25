[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8767,
  [switch]$CheckOnly,
  [switch]$SmokeTest,
  [switch]$NoBrowser,
  [switch]$DeveloperMode,
  [ValidateRange(0, 3600)]
  [int]$AutoStopAfterSeconds = 0
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DashboardUrl = "http://127.0.0.1:$Port"
$SummaryUrl = "$DashboardUrl/api/summary"
$script:ManagedProcess = $null
$script:StopRequested = $false
$ShutdownToken = [Guid]::NewGuid().ToString('N')

function Write-Bilingual {
  param(
    [string]$Chinese,
    [string]$English,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )
  Write-Host $Chinese -ForegroundColor $Color
  Write-Host $English -ForegroundColor $Color
}

function Stop-WithFriendlyError {
  param(
    [string]$Chinese,
    [string]$English
  )
  Write-Host ''
  Write-Bilingual -Chinese $Chinese -English $English -Color Red
  exit 1
}

function Test-TcpPort {
  param([int]$PortNumber)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-DashboardReady {
  try {
    $response = Invoke-WebRequest -Uri $SummaryUrl -UseBasicParsing -TimeoutSec 1
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return $false
    }
    $payload = $response.Content | ConvertFrom-Json
    return (
      $null -ne $payload.generated_at -and
      $null -ne $payload.jobs_shortlist_count -and
      $null -ne $payload.application_status_breakdown
    )
  } catch {
    return $false
  }
}

function Stop-ManagedDashboard {
  if ($null -eq $script:ManagedProcess) {
    return
  }
  try {
    if (-not $script:ManagedProcess.HasExited) {
      Write-Bilingual `
        -Chinese '正在停止本次启动的 Resume Jobs 服务……' `
        -English 'Stopping the Resume Jobs service started by this launcher...'
      $graceful = $false
      try {
        Invoke-WebRequest `
          -Uri "$DashboardUrl/api/runtime/shutdown" `
          -Method Post `
          -Headers @{ 'X-Resume-Jobs-Shutdown-Token' = $ShutdownToken } `
          -UseBasicParsing `
          -TimeoutSec 3 | Out-Null
        $graceful = $true
      } catch {
        # The owned process may have already stopped or may not yet be ready.
      }
      try {
        $script:ManagedProcess.WaitForExit($(if ($graceful) { 10000 } else { 2000 }))
      } catch {
        # The process has already been asked to stop. Do not expose a raw stack.
      }
      if (-not $script:ManagedProcess.HasExited) {
        Write-Bilingual `
          -Chinese '服务未能及时完成安全退出；正在停止本次启动的进程树。' `
          -English 'The service did not finish its graceful shutdown in time; stopping only this launcher-owned process tree.' `
          -Color Yellow
        & taskkill.exe /PID $script:ManagedProcess.Id /T /F 2>$null | Out-Null
        try { $script:ManagedProcess.WaitForExit(5000) } catch { Write-Verbose 'Owned process already exited.' }
      }
    }
  } catch {
    Write-Bilingual `
      -Chinese '服务可能仍在退出；没有删除或修改任何数据。' `
      -English 'The service may still be exiting; no data was deleted or modified.' `
      -Color Yellow
  }
}

function Open-Dashboard {
  if ($NoBrowser) {
    Write-Bilingual `
      -Chinese "浏览器打开已由测试参数关闭：$DashboardUrl" `
      -English "Browser opening is disabled by the test option: $DashboardUrl"
    return
  }
  try {
    Start-Process -FilePath $DashboardUrl | Out-Null
    Write-Bilingual `
      -Chinese 'Dashboard 已在默认浏览器中打开。' `
      -English 'The Dashboard has been opened in your default browser.' `
      -Color Green
  } catch {
    Write-Bilingual `
      -Chinese "无法自动打开浏览器，请手动打开：$DashboardUrl" `
      -English "The browser could not be opened automatically. Open: $DashboardUrl" `
      -Color Yellow
  }
}

Write-Host ''
Write-Host '============================================================'
Write-Bilingual `
  -Chinese 'Resume Jobs AI 求职助手' `
  -English 'Resume Jobs AI Assistant' `
  -Color Cyan
Write-Host '============================================================'
Write-Bilingual `
  -Chinese "项目目录：$ProjectRoot" `
  -English "Project folder: $ProjectRoot"
Write-Bilingual `
  -Chinese "Dashboard：$DashboardUrl" `
  -English "Dashboard: $DashboardUrl"
Write-Host ''

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  Stop-WithFriendlyError `
    -Chinese '缺少 Node.js。请安装 Node.js 18 或更高版本，然后重新双击启动器。下载地址：https://nodejs.org/' `
    -English 'Node.js is required. Install Node.js 18 or later, then open the launcher again: https://nodejs.org/'
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  Stop-WithFriendlyError `
    -Chinese '缺少 npm。请重新安装包含 npm 的 Node.js，然后重试。' `
    -English 'npm is required. Reinstall Node.js with npm, then try again.'
}

try {
  $nodeVersion = (& $nodeCommand.Source -p 'process.versions.node').Trim()
  $nodeMajor = [int]($nodeVersion.Split('.')[0])
} catch {
  Stop-WithFriendlyError `
    -Chinese '无法读取 Node.js 版本。请重新安装 Node.js 18 或更高版本。' `
    -English 'The Node.js version could not be read. Reinstall Node.js 18 or later.'
}
if ($nodeMajor -lt 18) {
  Stop-WithFriendlyError `
    -Chinese "Node.js 版本过旧（当前 $nodeVersion）。请安装 Node.js 18 或更高版本。" `
    -English "Your Node.js version is too old ($nodeVersion). Install Node.js 18 or later."
}

$requiredFiles = @(
  'package.json',
  'dashboard/server.mjs',
  'dashboard/public/index.html',
  'dashboard/public/app.js',
  'dashboard/public/style.css'
)
$missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ProjectRoot $_) -PathType Leaf) })
if ($missingFiles.Count -gt 0) {
  Stop-WithFriendlyError `
    -Chinese "项目文件不完整，缺少：$($missingFiles -join ', ')。请恢复完整项目后重试。" `
    -English "The project is incomplete. Missing: $($missingFiles -join ', '). Restore the complete project and try again."
}

try {
  $package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Stop-WithFriendlyError `
    -Chinese 'package.json 无法读取。请确认文件是有效 JSON。' `
    -English 'package.json could not be read. Make sure it contains valid JSON.'
}

if ($null -eq $package.scripts.app) {
  Stop-WithFriendlyError `
    -Chinese '项目缺少 npm run app 启动入口。请恢复当前版本的 package.json。' `
    -English 'The npm run app entry is missing. Restore package.json from the current project version.'
}

$missingDependencies = @()
if ($null -ne $package.dependencies) {
  foreach ($dependency in $package.dependencies.PSObject.Properties.Name) {
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $ProjectRoot 'node_modules') $dependency))) {
      $missingDependencies += $dependency
    }
  }
}
if ($missingDependencies.Count -gt 0) {
  Stop-WithFriendlyError `
    -Chinese "缺少项目依赖：$($missingDependencies -join ', ')。请在项目目录运行 npm install 后重试。" `
    -English "Project dependencies are missing: $($missingDependencies -join ', '). Run npm install in the project folder, then try again."
}

$searchPreferencesPath = Join-Path $ProjectRoot 'data/search_preferences.json'
if (-not (Test-Path -LiteralPath $searchPreferencesPath -PathType Leaf)) {
  Write-Bilingual `
    -Chinese '提示：尚未找到搜索配置。Dashboard 会使用安全默认值，首次启动后请在 Settings 中保存求职目标。' `
    -English 'Note: No saved search configuration was found. Safe defaults will be used; save your goals in Settings after launch.' `
    -Color Yellow
}

$privateProfilePath = Join-Path $ProjectRoot 'extensions/application_assistant/profile.local.json'
if (-not (Test-Path -LiteralPath $privateProfilePath -PathType Leaf)) {
  Write-Bilingual `
    -Chinese '提示：尚未配置私人求职资料。Dashboard 可以启动，但真实网站填表不可用。' `
    -English 'Note: A private application profile is not configured. The Dashboard can start, but real-site filling is unavailable.' `
    -Color Yellow
}

$portOpen = Test-TcpPort -PortNumber $Port
if ($portOpen) {
  if (Test-DashboardReady) {
    Write-Bilingual `
      -Chinese 'Resume Jobs Dashboard 已经在运行，不会重复启动服务。' `
      -English 'Resume Jobs Dashboard is already running; no duplicate service will be started.' `
      -Color Green
    if (-not $CheckOnly) {
      Open-Dashboard
    }
    exit 0
  }
  Stop-WithFriendlyError `
    -Chinese "端口 $Port 已被其他程序占用。请关闭占用该端口的程序，或使用其他端口启动。" `
    -English "Port $Port is already used by another program. Close that program or start Resume Jobs on a different port."
}

if ($CheckOnly) {
  Write-Bilingual `
    -Chinese '启动检查通过：Node.js、npm、依赖、项目文件和端口均可用。' `
    -English 'Startup check passed: Node.js, npm, dependencies, project files, and port are ready.' `
    -Color Green
  exit 0
}

try {
  $env:PORT = [string]$Port
  Write-Bilingual `
    -Chinese '正在启动本地 Dashboard……' `
    -English 'Starting the local Dashboard...'
  # PowerShell 5.1 Start-Process can fail when the parent environment contains
  # both Path and PATH. Use the .NET process API so Windows performs normal
  # case-insensitive environment inheritance while still invoking npm run app.
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $env:ComSpec
  # `call` keeps cmd.exe attached to npm.cmd, so the launcher owns the complete
  # npm -> Node process tree and can wait for a graceful Dashboard shutdown.
  $processInfo.Arguments = ('/d /s /c call "{0}" run app' -f $npmCommand.Source)
  $processInfo.WorkingDirectory = $ProjectRoot
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = -not $DeveloperMode
  $processInfo.EnvironmentVariables['RESUME_JOBS_SHUTDOWN_TOKEN'] = $ShutdownToken
  $script:ManagedProcess = [System.Diagnostics.Process]::new()
  $script:ManagedProcess.StartInfo = $processInfo
  if (-not $script:ManagedProcess.Start()) {
    throw 'npm run app could not be started.'
  }

  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($script:ManagedProcess.HasExited) {
      break
    }
    if (Test-DashboardReady) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 300
  }

  if (-not $ready) {
    Stop-WithFriendlyError `
      -Chinese 'Dashboard 未能在 20 秒内启动。请运行 npm run app 查看详细诊断，或查阅用户指南的常见问题。' `
      -English 'The Dashboard did not start within 20 seconds. Run npm run app for diagnostics or see the User Guide FAQ.'
  }

  Write-Bilingual `
    -Chinese 'Resume Jobs 已成功启动。' `
    -English 'Resume Jobs started successfully.' `
    -Color Green
  Open-Dashboard

  if ($SmokeTest) {
    Write-Bilingual `
      -Chinese '启动器冒烟测试通过；正在安全停止测试服务。' `
      -English 'Launcher smoke test passed; the test service will now stop.' `
      -Color Green
    $script:StopRequested = $true
  } elseif ($AutoStopAfterSeconds -gt 0) {
    Write-Bilingual `
      -Chinese "测试模式：服务将在 $AutoStopAfterSeconds 秒后自动停止。" `
      -English "Test mode: the service will stop automatically after $AutoStopAfterSeconds seconds."
    Start-Sleep -Seconds $AutoStopAfterSeconds
    $script:StopRequested = $true
  } else {
    Write-Host ''
    Write-Bilingual `
      -Chinese '保持此窗口打开即可使用 Resume Jobs。按 Enter 或 Q 可安全停止本次服务。' `
      -English 'Keep this window open while using Resume Jobs. Press Enter or Q to stop this session safely.' `
      -Color Cyan

    while (-not $script:ManagedProcess.HasExited) {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter -or $key.Key -eq [ConsoleKey]::Q) {
          $script:StopRequested = $true
          break
        }
      }
      Start-Sleep -Milliseconds 250
    }

    if ($script:ManagedProcess.HasExited -and -not $script:StopRequested) {
      Stop-WithFriendlyError `
        -Chinese 'Dashboard 服务意外停止。请重新启动；如问题持续，请运行 npm run app 查看诊断。' `
        -English 'The Dashboard service stopped unexpectedly. Restart it; if the problem continues, run npm run app for diagnostics.'
    }
  }
} catch {
  Stop-WithFriendlyError `
    -Chinese "Resume Jobs 启动失败：$($_.Exception.Message)" `
    -English "Resume Jobs could not start: $($_.Exception.Message)"
} finally {
  Stop-ManagedDashboard
}
