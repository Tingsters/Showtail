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
