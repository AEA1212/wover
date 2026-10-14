# Package Wover as dist\wover-<version>.xpi (Windows).
#
#   .\scripts\build.ps1         build an unsigned .xpi (for about:debugging,
#                               Firefox Developer Edition or Nightly)
#   .\scripts\build.ps1 -Sign   build a .xpi signed by Mozilla, installable in
#                               any Firefox (needs Node.js and AMO API keys,
#                               see "Signing" in README.md)
#
# If PowerShell refuses to run scripts, use scripts\build.cmd instead.
param([switch]$Sign)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$version = (Get-Content -Raw manifest.json | ConvertFrom-Json).version
New-Item -ItemType Directory -Force -Path dist | Out-Null

if ($Sign) {
  if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
    throw 'Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET first (see Signing in README.md).'
  }
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw 'Signing needs Node.js (npx): https://nodejs.org'
  }
  npx --yes web-ext@8 sign --channel=unlisted --source-dir . --artifacts-dir dist `
    --ignore-files 'docs/**' 'scripts/**' 'dist/**' 'node_modules/**' '*.md'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host 'Signed package written to dist\'
  exit 0
}

$out = Join-Path $root "dist\wover-$version.xpi"
if (Test-Path $out) { Remove-Item $out }

# Write the zip by hand: Firefox needs "/" in entry names, which older
# versions of Compress-Archive don't use.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $root -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
    $skip = $rel -match '^(\.|docs/|scripts/|dist/|node_modules/)' -or $rel -match '/\.' -or $rel -like '*.md'
    if (-not $skip) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}
Write-Host "Built $out"
