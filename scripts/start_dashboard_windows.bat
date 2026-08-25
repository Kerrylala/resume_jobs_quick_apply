@echo off
setlocal
title Resume Jobs AI Assistant

set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_dashboard_windows.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Press any key to close this window.
  pause >nul
)

endlocal & exit /b %EXIT_CODE%
