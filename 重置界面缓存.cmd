@echo off
chcp 65001 >nul 2>nul
REM  Reset the WebView2 UI cache. Use this when the app refuses to start
REM  with "the requested resource is in use" (0x800700AA).
REM  This folder holds NO novel data - your writing lives in the library
REM  folder (or, if you never picked one, inside the browser profile).
REM  THIS FILE MUST STAY PURE ASCII.
setlocal
set "TARGET=%LOCALAPPDATA%\com.novelstudio.desktop"
if not exist "%TARGET%" (
  echo   Nothing to reset: %TARGET% does not exist.
  pause
  exit /b 0
)
echo   Ending leftover msedgewebview2.exe ...
taskkill /f /im msedgewebview2.exe >nul 2>nul
echo   Moving the old UI cache aside ...
set "STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
move "%TARGET%" "%TARGET%.old-%STAMP%" >nul 2>nul
if exist "%TARGET%" (
  echo   [ERROR] Could not move it aside. Close every app window and try again.
  pause
  exit /b 1
)
echo   Done. Start the app again.
pause