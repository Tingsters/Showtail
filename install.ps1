# Showtail installer (Windows, PowerShell).
# Downloads the standalone showtail.exe from the latest GitHub Release.
# No runtime (Node/Bun) required.
#
#   irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
#
# Environment overrides:
#   $env:SHOWTAIL_REPO     "owner/repo"        (default: Tingsters/Showtail)
#   $env:SHOWTAIL_VERSION  "v0.1.0" or "latest" (default: latest)
#   $env:SHOWTAIL_BIN_DIR  install directory    (default: %LOCALAPPDATA%\Showtail\bin)

$ErrorActionPreference = 'Stop'

$repo = if ($env:SHOWTAIL_REPO) { $env:SHOWTAIL_REPO } else { 'Tingsters/Showtail' }
$version = if ($env:SHOWTAIL_VERSION) { $env:SHOWTAIL_VERSION } else { 'latest' }
# NOTE: must NOT be a ".showtail" directory — that name is Showtail's per-project
# data folder, so installing the binary there would make $HOME look like a project.
$binDir = if ($env:SHOWTAIL_BIN_DIR) { $env:SHOWTAIL_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Showtail\bin' }

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

# Persist to the user's PATH for future terminals (if not already there).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your user PATH."
}

# Also update THIS session so `showtail` works immediately. When the installer is
# run the documented way (`irm ... | iex`) this executes in your current shell, so
# the command is usable right away without opening a new terminal.
if (($env:Path -split ';') -notcontains $binDir) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host ''
if (Get-Command showtail -ErrorAction SilentlyContinue) {
  Write-Host 'Ready! Run: showtail --help'
} else {
  # Reached only if the script ran in a child process (e.g. `.\install.ps1`),
  # whose $env:Path change can't propagate to the parent shell.
  Write-Host 'Installed. Open a NEW terminal, then run: showtail --help'
}
