param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot

$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
if ($package.version -ne $Version) {
  throw "Requested version $Version does not match package.json version $($package.version)."
}

$versionSource = Get-Content -LiteralPath 'src/core/version.ts' -Raw
$versionMatch = [regex]::Match($versionSource, "SHOWTAIL_VERSION\s*=\s*'([^']+)'" )
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $Version) {
  throw 'Requested version does not match SHOWTAIL_VERSION.'
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = Join-Path $OutputDirectory 'showtail-windows-x64.exe'
$windowsVersion = "$Version.0"

$buildArgs = @(
  'build',
  '--compile',
  '--target=bun-windows-x64',
  './src/cli.ts',
  "--outfile=$output",
  '--windows-title=Showtail',
  '--windows-publisher=Showtail contributors',
  "--windows-version=$windowsVersion",
  '--windows-description=Showtail AI work provenance CLI',
  '--windows-copyright=Copyright 2026 Showtail contributors'
)

& bun @buildArgs
if ($LASTEXITCODE -ne 0) {
  throw "Bun failed to build the Windows executable (exit $LASTEXITCODE)."
}

$info = (Get-Item -LiteralPath $output).VersionInfo
$expected = @{
  ProductName = 'Showtail'
  CompanyName = 'Showtail contributors'
  ProductVersion = $windowsVersion
  FileVersion = $windowsVersion
  FileDescription = 'Showtail AI work provenance CLI'
  LegalCopyright = 'Copyright 2026 Showtail contributors'
}

foreach ($field in $expected.Keys) {
  if ($info.$field -ne $expected[$field]) {
    throw "$field was '$($info.$field)', expected '$($expected[$field])'."
  }
}

Write-Host "Built $output with validated Windows metadata."
