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

# Package the VS Code / Antigravity extension and ship it beside the binaries as
# `showtail.vsix`, so `connect antigravity-ide` can install it from disk (the
# installer must copy this next to the binary too — see bundledVsixPath()).
echo "Packaging the Showtail VS Code extension..."
# The extension is its own package with its own devDeps (esbuild, vsce) — install
# them before packaging, or `bun run package` fails with "Cannot find module
# 'esbuild'" (the deps aren't hoisted into the root node_modules).
( cd integrations/vscode && bun install && bun run package )
vsix="$(ls -t integrations/vscode/showtail-*.vsix | head -1)"
cp "$vsix" dist/showtail.vsix
echo "Bundled extension: $(basename "$vsix") -> dist/showtail.vsix"

echo "Done. Artifacts in dist/:"
ls -la dist/
