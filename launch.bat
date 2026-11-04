@echo off
REM =====================================================================
REM  CFO Content Engine — desktop launcher
REM
REM  1. Makes sure PM2 has the server + orchestrator running.
REM  2. Opens the dashboard in your default browser.
REM
REM  Safe to run repeatedly — PM2 reuses running processes.
REM =====================================================================

setlocal
cd /d "%~dp0"

echo.
echo  CFO Content Engine launcher
echo  ---------------------------

REM --- Ensure PM2 is installed ---
where pm2 >nul 2>nul
if errorlevel 1 (
  echo [setup] PM2 not found — installing globally...
  call npm install -g pm2 pm2-windows-startup
  if errorlevel 1 (
    echo.
    echo [error] PM2 install failed. Open a PowerShell as admin and run:
    echo        npm install -g pm2 pm2-windows-startup
    pause
    exit /b 1
  )
)

REM --- Ensure logs dir exists ---
if not exist "logs" mkdir "logs"

REM --- Start (or resurrect) the apps ---
pm2 describe cfo-server >nul 2>nul
if errorlevel 1 (
  echo [pm2] starting fresh...
  call pm2 start ecosystem.config.js
  call pm2 save
) else (
  echo [pm2] already running — status:
  call pm2 status
)

REM --- Give the server a moment, then open the dashboard ---
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo  Dashboard:  http://localhost:3000
echo  Logs:       pm2 logs
echo  Stop all:   pm2 stop all
echo.
endlocal
