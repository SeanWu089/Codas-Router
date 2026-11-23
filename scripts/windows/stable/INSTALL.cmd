@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0installer\Install-CodasSol.ps1" %*
set "codas_exit=%errorlevel%"
if not "%codas_exit%"=="0" echo Installation did not complete. Review the error and retained transaction evidence. No security policy was changed.
if "%~1"=="" pause
exit /b %codas_exit%
