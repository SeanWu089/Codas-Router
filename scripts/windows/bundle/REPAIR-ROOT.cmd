@echo off
setlocal
title Codas DevSpace Root Repair
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%repair-root.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
  echo Codas root repair failed with exit code %EXIT_CODE%.
) else (
  echo Codas root repair finished successfully.
)
echo.
pause
exit /b %EXIT_CODE%
