#!/usr/bin/env bash

# Build the non-Windows standalone release artifacts. The Windows executable is
# built separately on Windows because Bun rejects its metadata flags elsewhere.

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

build() {
  local target="$1" out="$2"
  echo "Building $out (target: $target)..."
  bun build --compile --target="$target" ./src/cli.ts --outfile "dist/$out"
}

build bun-linux-x64    showtail-linux-x64
build bun-linux-arm64  showtail-linux-arm64
build bun-darwin-x64   showtail-darwin-x64
build bun-darwin-arm64 showtail-darwin-arm64
