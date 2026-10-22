@echo off
setlocal
cd /d "%~dp0"
if not exist config.json copy config.example.json config.json >nul
if defined DEEPSEEK_FRIEND_PYTHON (
  "%DEEPSEEK_FRIEND_PYTHON%" launcher.py
) else if exist "G:\Python\Python_Environment\Python310\python.exe" (
  "G:\Python\Python_Environment\Python310\python.exe" launcher.py
) else (
  python launcher.py
)
if errorlevel 1 pause
endlocal
