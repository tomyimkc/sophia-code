@echo off
setlocal EnableExtensions
set "HERE=%~dp0"
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%HERE%install_sophia_lite.py" %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%HERE%install_sophia_lite.py" %*
  exit /b %ERRORLEVEL%
)
echo sophia-lite: Python 3.11+ not found. Install Python and keep py or python on PATH. 1>&2
exit /b 127
