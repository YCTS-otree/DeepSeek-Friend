@echo off
setlocal
cd /d "%~dp0"
node scripts\dsh.js start
if errorlevel 1 pause
endlocal
