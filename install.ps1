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
#   $env:SHOWTAIL_DISABLE_FIRST_RUN=1 downloads only; skips capture/tool setup

$ErrorActionPreference = 'Stop'

$repo = if ($env:SHOWTAIL_REPO) { $env:SHOWTAIL_REPO } else { 'Tingsters/Showtail' }
$version = if ($env:SHOWTAIL_VERSION) { $env:SHOWTAIL_VERSION } else { 'latest' }
# NOTE: must NOT be a ".showtail" directory — that name is Showtail's per-project
# data folder, so installing the binary there would make $HOME look like a project.
$binDir = if ($env:SHOWTAIL_BIN_DIR) { $env:SHOWTAIL_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Showtail\bin' }

$asset = 'showtail-windows-x64.exe'

if ($version -eq 'latest') {
  $releaseBase = "https://github.com/$repo/releases/latest/download"
} else {
  $releaseBase = "https://github.com/$repo/releases/download/$version"
}
$url = "$releaseBase/$asset"
$checksumUrl = "$releaseBase/SHA256SUMS"

Write-Host "Installing showtail ($asset) from $repo..."
Write-Host "  Files: $binDir (executable and bundled editor extension)"
Write-Host '  System: adds that directory to your user PATH'
if (-not $env:SHOWTAIL_DISABLE_FIRST_RUN) {
  Write-Host '  Setup: enables local capture and may configure detected AI tools'
} else {
  Write-Host '  Setup: skipped because SHOWTAIL_DISABLE_FIRST_RUN is set'
}
Write-Host '  Removal: https://tingsters.github.io/Showtail/getting-started/uninstallation/'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$target = Join-Path $binDir 'showtail.exe'
$token = [guid]::NewGuid().ToString('N')
$download = Join-Path $binDir ".showtail-$token.tmp"
$checksums = Join-Path $binDir ".showtail-checksums-$token.tmp"
$backup = Join-Path $binDir ".showtail-$token.previous"

function Get-ExpectedHash([string]$name, [string[]]$lines) {
  $pattern = '^([0-9a-fA-F]{64})\s{2}' + [regex]::Escape($name) + '$'
  foreach ($line in $lines) {
    $match = [regex]::Match($line, $pattern)
    if ($match.Success) { return $match.Groups[1].Value.ToLowerInvariant() }
  }
  throw "SHA256SUMS does not include $name."
}

try {
  Invoke-WebRequest -Uri $checksumUrl -OutFile $checksums -UseBasicParsing
  $checksumLines = Get-Content -LiteralPath $checksums
  $expected = Get-ExpectedHash $asset $checksumLines
  Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 verification failed for $asset." }

  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup -Force
  }
  try {
    Move-Item -LiteralPath $download -Destination $target -Force
    $reportedVersion = (& $target --version | Out-String).Trim()
    if ($reportedVersion -notmatch '^\d+\.\d+\.\d+$') {
      throw "Installed executable reported an invalid version: $reportedVersion"
    }
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  } catch {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backup) {
      Move-Item -LiteralPath $backup -Destination $target -Force
    }
    throw
  }
} finally {
  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $checksums -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed and verified: $target"

# Fetch the VS Code / Antigravity extension (VSIX) beside the binary so Showtail can
# install its editor extension hands-off (bundledVsixPath() looks here). Best-effort — a
# failed fetch never fails the install (the extension step falls back to guidance).
$vsixUrl = "$releaseBase/showtail.vsix"
$vsixTarget = Join-Path $binDir 'showtail.vsix'
$vsixDownload = Join-Path $binDir ".showtail-vsix-$token.tmp"
$vsixBackup = Join-Path $binDir ".showtail-vsix-$token.previous"
try {
  $expectedVsix = Get-ExpectedHash 'showtail.vsix' $checksumLines
  Invoke-WebRequest -Uri $vsixUrl -OutFile $vsixDownload -UseBasicParsing
  $actualVsix = (Get-FileHash -Algorithm SHA256 -LiteralPath $vsixDownload).Hash.ToLowerInvariant()
  if ($actualVsix -ne $expectedVsix) { throw 'SHA-256 verification failed for showtail.vsix.' }
  if (Test-Path -LiteralPath $vsixTarget) {
    Move-Item -LiteralPath $vsixTarget -Destination $vsixBackup -Force
  }
  try {
    Move-Item -LiteralPath $vsixDownload -Destination $vsixTarget -Force
    Remove-Item -LiteralPath $vsixBackup -Force -ErrorAction SilentlyContinue
  } catch {
    if (Test-Path -LiteralPath $vsixBackup) {
      Remove-Item -LiteralPath $vsixTarget -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $vsixBackup -Destination $vsixTarget -Force
    }
    throw
  }
} catch {
  Write-Host 'The bundled editor extension could not be updated; the CLI is ready.'
} finally {
  Remove-Item -LiteralPath $vsixDownload -Force -ErrorAction SilentlyContinue
}

# Turn tracking on automatically — make Showtail "just work" with no setup command:
# connect the AI tools you have and pre-wire the rest, so a tool you install later never
# loses work. Once-only and idempotent; best-effort so a hiccup never fails the install.
Write-Host ''
try {
  & $target setup --first-run --offer-migration
} catch {
  Write-Host 'Showtail is installed. Tracking will turn on the first time you use it.'
}

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
