# Showtail installer (Windows, PowerShell).
# Downloads the standalone showtail.exe from the latest GitHub Release.
# No runtime (Node/Bun) required.
#
#   irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
#
# Environment overrides:
#   $env:SHOWTAIL_REPO     "owner/repo"        (default: Tingsters/Showtail)
#   $env:SHOWTAIL_VERSION  "v0.1.0" or "latest" (default: latest)
#   $env:SHOWTAIL_BIN_DIR  install directory    (default: $HOME\.showtail\bin)

$ErrorActionPreference = 'Stop'

$repo = if ($env:SHOWTAIL_REPO) { $env:SHOWTAIL_REPO } else { 'Tingsters/Showtail' }
$version = if ($env:SHOWTAIL_VERSION) { $env:SHOWTAIL_VERSION } else { 'latest' }
$binDir = if ($env:SHOWTAIL_BIN_DIR) { $env:SHOWTAIL_BIN_DIR } else { Join-Path $HOME '.showtail\bin' }

$asset = 'showtail-windows-x64.exe'

if ($version -eq 'latest') {
  $url = "https://github.com/$repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$repo/releases/download/$version/$asset"
}

Write-Host "Installing showtail ($asset) from $repo..."

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$target = Join-Path $binDir 'showtail.exe'

Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing

Write-Host "Installed to: $target"

# Add to the user's PATH if it isn't already there.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host ''
  Write-Host "Added $binDir to your user PATH."
  Write-Host 'Open a new terminal, then run: showtail --help'
} else {
  Write-Host 'Ready! Run: showtail --help'
}
