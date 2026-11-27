@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ ^(22.5+ recommended^) is required. Install from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS 1>&2
  exit /b 1
)
node "%~dp0scripts\install.mjs"
exit /b %ERRORLEVEL%
