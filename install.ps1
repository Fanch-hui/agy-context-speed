$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js 20+ (22.5+ recommended) is required. Install from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS'
  exit 1
}
& node (Join-Path $PSScriptRoot 'scripts\install.mjs')
exit $LASTEXITCODE
