@echo off
REM One-click start: MySQL(3307) + API(3000) + Web(5173)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-start.ps1"
echo.
pause
