@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 18+ from https://nodejs.org
  pause
  exit /b 1
)
if not exist data mkdir data
if not exist media mkdir media
node server.js
pause
