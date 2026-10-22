@echo off
setlocal
cd /d "%~dp0"
node src\main.js login
if errorlevel 1 pause
endlocal
