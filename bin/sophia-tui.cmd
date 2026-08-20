@echo off
setlocal EnableExtensions
set "SOPHIA_UI=tui"
call "%~dp0sophia.cmd" %*
exit /b %ERRORLEVEL%
