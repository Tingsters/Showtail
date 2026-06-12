#!/usr/bin/env bash
#
# Build standalone Showtail binaries for every supported platform using
# `bun build --compile`. Output goes to dist/. Used locally and by CI.

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

# Map: bun --target  ->  release asset name
build() {
  local target="$1" out="$2"
  echo "Building $out (target: $target)..."
  bun build --compile --target="$target" ./src/cli.ts --outfile "dist/$out"
}

build bun-linux-x64    showtail-linux-x64
build bun-darwin-x64   showtail-darwin-x64
build bun-darwin-arm64 showtail-darwin-arm64
build bun-windows-x64  showtail-windows-x64.exe

echo "Done. Artifacts in dist/:"
ls -la dist/
