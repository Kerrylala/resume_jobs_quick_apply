@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo 缺少 Node.js，请先安装 Node.js 18 或更高版本。
  echo Node.js 18 or later is required.
  echo.
  pause
  exit /b 1
)

node scripts\run_offline_demo.mjs
set "DEMO_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%DEMO_EXIT_CODE%"=="0" (
  echo 离线演示未完成，请查看上面的错误信息。
  echo The offline demo did not complete. Review the message above.
) else (
  if "%RESUME_JOBS_DEMO_NO_OPEN%"=="1" (
    echo 离线演示已完成，报告已经生成。
    echo The offline demo is complete and its report was generated.
  ) else (
    echo 离线演示已完成，报告已在默认浏览器中打开。
    echo The offline demo is complete and its report was opened.
  )
)
echo.
pause
exit /b %DEMO_EXIT_CODE%
