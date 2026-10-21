@echo off
chcp 65001 >nul 2>nul
REM ============================================================
REM  launcher for the app (see scripts/launch.mjs)
REM
REM  Double-click this file to start the app.
REM
REM  Keep this window open while you use it. Closing the window
REM  stops the local server and the page will stop loading.
REM  Your data is saved in files, so nothing is lost.
REM
REM  !!! THIS FILE MUST STAY PURE ASCII !!!
REM  cmd.exe mis-reads multi-byte characters in batch files once the
REM  code page is switched to UTF-8: it starts running half-characters
REM  as commands ("'ho' is not recognized as an internal or external
REM  command"). All Chinese messages are printed by the Node scripts
REM  under scripts\ instead, where UTF-8 output is reliable.
REM ============================================================

setlocal
set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
set "PATH=%NODE_DIR%;%PATH%"

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Expected at: %NODE_DIR%\node.exe
  echo   If Node is installed somewhere else, edit NODE_DIR at the top of this file.
  echo.
  pause
  exit /b 1
)

REM Build once if the app files are missing.
if not exist "dist\index.html" (
  echo.
  echo   First run: preparing app files, about 30 seconds...
  echo.
  if not exist "node_modules" (
    call npm install --no-audit --no-fund
    if errorlevel 1 (
      echo   [ERROR] npm install failed. Check your network and try again.
      pause
      exit /b 1
    )
  )
  call npm run build
  if errorlevel 1 (
    echo   [ERROR] Build failed. Send the output above to the AI.
    pause
    exit /b 1
  )
)

node scripts\launch.mjs

REM Only stop to show a message when something went wrong.
REM Exit code 0 means either "already running" or "you closed the server".
if errorlevel 1 pause
