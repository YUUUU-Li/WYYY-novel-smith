@echo off
chcp 65001 >nul 2>nul
REM ============================================================
REM  Install Rust (used to build the desktop exe)
REM
REM  Why this script instead of re-running rustup-init.exe:
REM  double-clicking that asks the three-way menu again, and its
REM  MSVC prerequisite check may drag you into the Visual Studio
REM  installer. Your VS is already set up, so we pass -y to skip
REM  every prompt.
REM
REM  This script is idempotent: it skips if Rust is already there.
REM
REM  !!! THIS FILE MUST STAY PURE ASCII !!!
REM  cmd.exe mis-reads multi-byte characters in batch files once the
REM  code page is switched to UTF-8, and starts running half-
REM  characters as commands. Keep all Chinese out of .cmd files.
REM ============================================================

setlocal

set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
set "INSTALLER=%USERPROFILE%\Downloads\rustup-init.exe"

echo.
echo   Install Rust
echo   ================================
echo.

REM Already installed? Skip.
if exist "%CARGO_BIN%\cargo.exe" (
  echo   Rust is already installed, skipping.
  "%CARGO_BIN%\cargo.exe" --version
  goto :done
)

if not exist "%INSTALLER%" (
  echo   [ERROR] Installer not found:
  echo   %INSTALLER%
  echo.
  echo   Download rustup-init.exe from https://rustup.rs first,
  echo   or point INSTALLER= below at wherever you saved it.
  goto :fail
)

echo   Installing. No input needed, about 3 to 8 minutes...
echo   (it downloads a few hundred MB of compiler and stdlib)
echo.

REM -y                 skip every prompt, accept the defaults
REM --no-modify-path   leave the system PATH alone (avoids needing
REM                    admin); the launcher adds the path itself
"%INSTALLER%" -y --default-toolchain stable --profile minimal --no-modify-path

if errorlevel 1 (
  echo.
  echo   [ERROR] Install failed. Copy the output above to the AI.
  goto :fail
)

echo.
if exist "%CARGO_BIN%\cargo.exe" (
  echo   Done:
  "%CARGO_BIN%\cargo.exe" --version
  goto :done
)

echo   [WARNING] The installer reported success but cargo.exe is missing.
echo   Copy the output above to the AI.
goto :fail

:done
echo.
echo   ================================
echo   Go back to the chat and say "Rust is installed".
echo   ================================
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
