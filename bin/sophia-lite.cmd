@echo off
setlocal EnableExtensions
rem Open edition: no Conscience / effort / A2A / workflow / AGI-shaped surfaces.
set "SOPHIA_EDITION=oss"
call "%~dp0sophia.cmd" lite %*
exit /b %ERRORLEVEL%
