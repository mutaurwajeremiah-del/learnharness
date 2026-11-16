<#
.SYNOPSIS
  Installs the custom LearnHarness build, working around a known Windows
  issue where a silent NSIS install can intermittently drop files (observed:
  node_modules under resources\server\standalone, breaking "Cannot find
  module 'next'") — most likely real-time antivirus scanning interfering
  with the installer's rapid extraction of many small files.

.DESCRIPTION
  Installs silently, then verifies the one file most likely to be missing
  (node_modules\next). If it is missing, falls back to a direct robocopy of
  the already-built, already-verified dist\win-unpacked folder over the
  install location — this bypasses NSIS's extraction entirely and is what
  actually worked when this was first hit. Never touches %APPDATA%\LearnHarness
  (your chats, graph, settings, credentials).

.PARAMETER InstallerPath
  Path to the *-setup.exe. Defaults to the newest one in <repo>\dist.
#>
[CmdletBinding()]
param(
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\learnharness')
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\LearnHarness'

if (-not $InstallerPath) {
  $InstallerPath = (Get-ChildItem (Join-Path $repo 'dist') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) {
  throw 'No installer found. Build one first with scripts\windows\build-windows-installer.ps1.'
}
Write-Host "Installer: $InstallerPath"

Get-Process -Name LearnHarness -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if (Test-Path -LiteralPath $installDir) {
  # Program files only — never %APPDATA%\LearnHarness (your data).
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

Write-Host 'Installing (silent)...'
$proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru
for ($i = 0; $i -lt 24 -and -not (Test-Path (Join-Path $installDir 'LearnHarness.exe')); $i++) { Start-Sleep -Seconds 5 }
Get-Process -Name 'LearnHarness-*-x64-setup' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name LearnHarness -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$nextOk = Test-Path (Join-Path $installDir 'resources\server\standalone\node_modules\next')
if (-not $nextOk) {
  Write-Host 'The silent install dropped files during extraction (a known Windows Defender / NSIS interaction).' -ForegroundColor Yellow
  Write-Host 'Falling back to a direct copy of the verified build output...'
  $unpacked = Join-Path $repo 'dist\win-unpacked'
  if (-not (Test-Path (Join-Path $unpacked 'resources\server\standalone\node_modules\next'))) {
    throw "dist\win-unpacked is also missing node_modules\next — rebuild with build-windows-installer.ps1 first."
  }
  if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  robocopy $unpacked $installDir /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy fallback failed with exit code $LASTEXITCODE." }
  $nextOk = Test-Path (Join-Path $installDir 'resources\server\standalone\node_modules\next')
}

if (-not $nextOk) { throw 'Install verification failed even after the fallback copy. Do not run the app; investigate before proceeding.' }

# Stop the auto-updater from ever replacing this build with a plain upstream
# release — electron-updater has no on/off setting, so this points its baked-in
# feed at an address that always fails, harmlessly, on every check.
$updateYml = Join-Path $installDir 'resources\app-update.yml'
@"
provider: generic
url: http://127.0.0.1:1/updates-disabled-for-custom-build
updaterCacheDirName: learnharness-updater
"@ | Set-Content -LiteralPath $updateYml -Encoding utf8
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'learnharness-updater\pending') -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "VERIFIED: LearnHarness installed at $installDir" -ForegroundColor Green
Write-Host '  - node_modules\next present (server can start)'
Write-Host '  - auto-update disabled (this custom build will not be silently replaced)'
Write-Host '  - your data in %APPDATA%\LearnHarness was not touched'
Write-Host ''
Write-Host 'Launch it, then check Settings > Agent > Workspace shows "Ready".'
