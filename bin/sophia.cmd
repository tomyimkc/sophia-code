@echo off
setlocal EnableExtensions
rem Open-edition / source-checkout launcher for Windows cmd and PowerShell.
rem POSIX uses bin\sophia (bash). canClaimAGI:false.
set "PYTHONDONTWRITEBYTECODE=1"
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "PYTHONPATH=%ROOT%;%PYTHONPATH%"
if not defined SOPHIA_RESOURCE_ROOT set "SOPHIA_RESOURCE_ROOT=%ROOT%"
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -B -m sophia.cli %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -B -m sophia.cli %*
  exit /b %ERRORLEVEL%
)
echo sophia: Python 3.11+ not found. Install Python and keep py or python on PATH. 1>&2
exit /b 127
