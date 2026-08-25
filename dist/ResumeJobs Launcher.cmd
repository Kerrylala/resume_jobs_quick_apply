@echo off
setlocal
call "%~dp0..\scripts\start_dashboard_windows.bat" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
