@echo off
setlocal
title Codas Windows Agent Installer

set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Codas installation failed with exit code %EXIT_CODE%.
  echo The error above should explain what needs attention.
) else (
  echo Codas installation finished successfully.
)
echo.
pause
exit /b %EXIT_CODE%
