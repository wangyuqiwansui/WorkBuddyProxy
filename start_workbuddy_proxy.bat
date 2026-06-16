@echo off
setlocal
cd /d "%~dp0"

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/
set npm_config_registry=https://registry.npmmirror.com/

npm -v >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm is required to run the Electron app.
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  echo Installing Electron dependencies...
  echo Electron mirror: %ELECTRON_MIRROR%
  npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)
npm start
