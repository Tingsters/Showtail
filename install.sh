#!/usr/bin/env bash
#
# Showtail installer (macOS / Linux).
# Downloads the standalone `showtail` binary from the latest GitHub Release.
# No runtime (Node/Bun) required.
#
#   curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
#
# Environment overrides:
#   SHOWTAIL_REPO     "owner/repo"        (default: Tingsters/Showtail)
#   SHOWTAIL_VERSION  "v0.1.0" or "latest" (default: latest)
#   SHOWTAIL_BIN_DIR  install directory    (default: $HOME/.local/bin)

set -euo pipefail

REPO="${SHOWTAIL_REPO:-Tingsters/Showtail}"
VERSION="${SHOWTAIL_VERSION:-latest}"
# NOTE: must NOT be a ".showtail" directory — that name is Showtail's per-project
# data folder, so installing the binary there would make $HOME look like a project.
BIN_DIR="${SHOWTAIL_BIN_DIR:-$HOME/.local/bin}"

err() { echo "error: $*" >&2; exit 1; }

# --- Detect platform ------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat_os="darwin" ;;
  Linux)  plat_os="linux" ;;
  *) err "unsupported OS: $os. Try the 'From source' install in the README." ;;
esac

case "$arch" in
  x86_64|amd64) plat_arch="x64" ;;
  arm64|aarch64) plat_arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

# Bun's compile targets don't include linux-arm64 binaries in our release matrix.
asset="showtail-${plat_os}-${plat_arch}"

# --- Resolve the download URL --------------------------------------------
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "Installing showtail (${asset}) from ${REPO}..."

mkdir -p "$BIN_DIR"
target="${BIN_DIR}/showtail"

if command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$target" || err "download failed from $url"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$target" "$url" || err "download failed from $url"
else
  err "need curl or wget to download showtail"
fi

chmod +x "$target"

echo "Installed to: $target"

# --- Fetch the VS Code / Antigravity extension (VSIX) ---------------------
# Drop `showtail.vsix` beside the binary so Showtail can install its editor extension
# hands-off (bundledVsixPath() looks here). Best-effort: a failed fetch never fails the
# install — the extension step then falls back to the Marketplace or to guidance.
if [ "$VERSION" = "latest" ]; then
  vsix_url="https://github.com/${REPO}/releases/latest/download/showtail.vsix"
else
  vsix_url="https://github.com/${REPO}/releases/download/${VERSION}/showtail.vsix"
fi
vsix_target="${BIN_DIR}/showtail.vsix"
if command -v curl >/dev/null 2>&1; then
  curl -fSL "$vsix_url" -o "$vsix_target" 2>/dev/null || rm -f "$vsix_target"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$vsix_target" "$vsix_url" 2>/dev/null || rm -f "$vsix_target"
fi

# --- Turn tracking on automatically ---------------------------------------
# Make Showtail "just work" with no setup command: connect the AI tools you have and
# pre-wire the rest, so a tool you install later never loses work. Once-only and
# idempotent (a re-install never fights a `setup --off`/`disconnect`). Best-effort —
# a bootstrap hiccup must never fail the install.
echo ""
if ! "$target" setup --first-run 2>/dev/null; then
  echo "Showtail is installed. Tracking will turn on the first time you use it."
fi

# --- PATH guidance --------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Ready! Run: showtail --help" ;;
  *)
    echo ""
    echo "Add this to your shell profile (~/.bashrc, ~/.zshrc) to use 'showtail' everywhere:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    echo "Or run it directly: $target --help"
    ;;
esac
