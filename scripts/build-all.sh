#!/usr/bin/env bash
#
# Build release artifacts that can be produced from a Unix host. The signed
# Windows release build must run through scripts/build-windows.ps1 on Windows so
# Bun can add the metadata enforced by SignPath.

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

bash scripts/build-non-windows.sh

# Package the VS Code / Antigravity extension and ship it beside the binaries as
# `showtail.vsix`, so `connect antigravity-ide` can install it from disk (the
# installer must copy this next to the binary too — see bundledVsixPath()).
echo "Packaging the Showtail VS Code extension..."
# The extension is its own package with its own devDeps (esbuild, vsce) — install
# them before packaging, or `bun run package` fails with "Cannot find module
# 'esbuild'" (the deps aren't hoisted into the root node_modules).
( cd integrations/vscode && bun install --frozen-lockfile && bun run package )
extension_version="$(node -p "require('./integrations/vscode/package.json').version")"
vsix="integrations/vscode/showtail-${extension_version}.vsix"
cp "$vsix" dist/showtail.vsix
echo "Bundled extension: $(basename "$vsix") -> dist/showtail.vsix"

echo "Done. Artifacts in dist/:"
ls -la dist/
echo "Windows release builds must run on Windows:"
echo "  powershell -File scripts/build-windows.ps1 -Version <version>"
