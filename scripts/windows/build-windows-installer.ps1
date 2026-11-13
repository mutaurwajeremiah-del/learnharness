<#
.SYNOPSIS
  Builds the custom LearnHarness Windows x64 installer using the repository's
  documented pipeline (docs/desktop-release.md, "Build pipeline").

.DESCRIPTION
  Run this on Windows, in PowerShell, from anywhere. It does NOT touch the
  installed app or its data (%APPDATA%\LearnHarness) and never bundles API
  keys. Stops at the first failing step and prints the installer path, size and
  SHA-256 on success.

  Requirements: Node.js 26 (what CI uses), Git, and internet access (npm
  packages, and Google Fonts during `next build`). If electron-builder fails
  with "Cannot create symbolic link", enable Windows Developer Mode
  (Settings > System > For developers) or run PowerShell as Administrator.

.PARAMETER FullTests
  Also run the entire test suite (slow). By default the workspace-file tests,
  type-check and lint run (these include the Windows-only junction test).

.PARAMETER SkipChecks
  Skip type-check, lint and tests (not recommended).
#>
[CmdletBinding()]
param(
  [switch]$FullTests,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo
Write-Host "Repository: $repo"

function Invoke-Step {
  param([string]$Name, [scriptblock]$Action)
  Write-Host ''
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "Step failed: $Name (exit code $LASTEXITCODE)" }
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 26) {
  throw "Node.js $nodeVersion found; this repository's CI and release builds use Node 26. Install Node 26 and re-run."
}
Write-Host "Node $nodeVersion, npm $(& npm -v)"

# Unsigned Windows build: do not go looking for a signing certificate.
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

Invoke-Step 'npm ci' { npm ci }

if (-not $SkipChecks) {
  Invoke-Step 'Type-check' { npm run typecheck }
  Invoke-Step 'Lint' { npm run lint }
  Invoke-Step 'Workspace-file tests (incl. Windows junction escape test)' {
    $env:NODE_ENV = 'test'
    $files = @(Get-ChildItem tests\workspace-*.test.ts, tests\workspace-*.test.tsx | ForEach-Object { $_.FullName })
    npx tsx --test @files
  }
  if ($FullTests) {
    Invoke-Step 'Full test suite' {
      $env:NODE_ENV = 'test'
      $files = @(Get-ChildItem tests\*.test.ts, tests\*.test.tsx | ForEach-Object { $_.FullName })
      npx tsx --test @files
    }
  }
}

Invoke-Step 'next build' { $env:NODE_ENV = 'production'; npm run build }
Invoke-Step 'Provider runtime smoke' { node scripts/smoke-provider-runtime.mjs }
Invoke-Step 'Curate standalone server' { node scripts/build-server.mjs }
Invoke-Step 'Server smoke under Electron' { node scripts/smoke-server.mjs --electron }
Invoke-Step 'electron-builder (Windows x64 installer)' { npx electron-builder --win --x64 --publish never }

$installer = Get-ChildItem -Path (Join-Path $repo 'dist') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'Build finished but no *-setup.exe was found in dist\. Check the electron-builder output above.' }
$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
Write-Host ''
Write-Host 'INSTALLER BUILT' -ForegroundColor Green
Write-Host "  Path   : $($installer.FullName)"
Write-Host "  Size   : $([math]::Round($installer.Length / 1MB, 1)) MB"
Write-Host "  SHA-256: $hash"
Write-Host ''
Write-Host 'Next: close LearnHarness, run scripts\windows\backup-learnharness-data.ps1, then run the installer.'
Write-Host 'Then open Settings > Agent > Workspace, and turn OFF automatic updates so the upstream release cannot replace this build.'
