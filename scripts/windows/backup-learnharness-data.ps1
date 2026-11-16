<#
.SYNOPSIS
  Makes a VERIFIED backup of the installed LearnHarness's user data (chats,
  knowledge graph, settings, provider configuration and credentials).

.DESCRIPTION
  Copies everything in %APPDATA%\LearnHarness except disposable browser caches
  into a new timestamped folder, then re-reads BOTH copies and compares every
  file's size and SHA-256. Writes MANIFEST.csv and only prints VERIFIED when
  every file matches. It never modifies, moves or deletes the original data.

  The backup contains your API keys / sign-in credentials in plain files.
  Keep it OUTSIDE OneDrive and never share it.

  Close LearnHarness first (open databases and lock files cannot be copied
  reliably while the app is running).

.PARAMETER Source
  LearnHarness user-data folder. Default: %APPDATA%\LearnHarness

.PARAMETER BackupRoot
  Where timestamped backups are created.
  Default: C:\Users\hp\Development\learnharness-backups
#>
[CmdletBinding()]
param(
  [string]$Source = (Join-Path $env:APPDATA 'LearnHarness'),
  [string]$BackupRoot = 'C:\Users\hp\Development\learnharness-backups'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
  throw "LearnHarness data folder not found: $Source"
}
$running = Get-Process -Name 'LearnHarness' -ErrorAction SilentlyContinue
if ($running) {
  throw 'LearnHarness is running. Close it completely (check the system tray), then run this script again.'
}

# Disposable Chromium caches: not user data, large, and often locked.
$excludeDirs = @('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'GPUPersistentCache', 'Shared Dictionary')
$excludeFiles = @('lockfile', '*.db-journal', 'DIPS', 'DIPS-wal')

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$dest = Join-Path $BackupRoot "LearnHarness-userdata_$stamp"
if (Test-Path -LiteralPath $dest) { throw "Backup folder already exists: $dest" }
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Write-Host "Source : $Source"
Write-Host "Backup : $dest"
Write-Host 'Copying (read-only on the source)...'

$xd = @(); foreach ($d in $excludeDirs) { $xd += '/XD'; $xd += (Join-Path $Source $d) }
$xf = @(); foreach ($f in $excludeFiles) { $xf += '/XF'; $xf += $f }
# /E subfolders, /COPY:DAT data+attributes+timestamps, /R:1 /W:1 fail fast on locks.
& robocopy $Source $dest /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP @xd @xf | Out-Null
# robocopy exit codes 0-7 are success variants; 8 and above are failures.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE. Nothing was verified; do not rely on this backup." }

Write-Host 'Verifying every file (size + SHA-256)...'
function Get-RelativeFiles([string]$Root) {
  $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    [pscustomobject]@{ Relative = $_.FullName.Substring($rootFull.Length + 1); Path = $_.FullName; Length = $_.Length }
  }
}
function Test-Excluded([string]$Relative) {
  $parts = $Relative -split '\\'
  foreach ($d in $excludeDirs) { if ($parts[0] -ieq $d) { return $true } }
  foreach ($f in $excludeFiles) { if ($parts[-1] -like $f) { return $true } }
  return $false
}

$srcFiles = Get-RelativeFiles $Source | Where-Object { -not (Test-Excluded $_.Relative) }
$dstMap = @{}
Get-RelativeFiles $dest | ForEach-Object { $dstMap[$_.Relative.ToLowerInvariant()] = $_ }

$manifest = New-Object System.Collections.Generic.List[object]
$problems = New-Object System.Collections.Generic.List[string]
$totalBytes = 0L
foreach ($s in $srcFiles) {
  $d = $dstMap[$s.Relative.ToLowerInvariant()]
  if (-not $d) { $problems.Add("MISSING in backup: $($s.Relative)"); continue }
  if ($d.Length -ne $s.Length) { $problems.Add("SIZE differs: $($s.Relative)"); continue }
  $hs = (Get-FileHash -LiteralPath $s.Path -Algorithm SHA256).Hash
  $hd = (Get-FileHash -LiteralPath $d.Path -Algorithm SHA256).Hash
  if ($hs -ne $hd) { $problems.Add("HASH differs: $($s.Relative)"); continue }
  $totalBytes += $s.Length
  $manifest.Add([pscustomobject]@{ File = $s.Relative; Bytes = $s.Length; SHA256 = $hs })
}
$manifest | Export-Csv -LiteralPath (Join-Path $dest 'MANIFEST.csv') -NoTypeInformation -Encoding UTF8

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  throw "Backup verification FAILED ($($problems.Count) problem(s)). Do not rely on $dest."
}

Write-Host ''
Write-Host "VERIFIED: $($manifest.Count) files, $([math]::Round($totalBytes / 1MB, 2)) MB, all SHA-256 hashes match." -ForegroundColor Green
Write-Host "Backup location: $dest"
Write-Host 'Keep this folder outside OneDrive. It contains your credentials.'
