#!/usr/bin/env bash
#
# Copy the tree-sitter WASM runtime and the grammar blobs Showtail embeds for
# entity-level diffs from node_modules into assets/grammars/. These committed
# assets are embedded into the compiled binary (see src/core/grammars.ts), the
# same way SKILL.md is — so the binary is fully self-contained.
#
# Re-run after bumping web-tree-sitter / tree-sitter-wasms:
#   bun run sync:grammars
#
# The grammar list is the single source of truth in GRAMMARS below and must stay
# in sync with the LANGUAGES table in src/core/grammars.ts (a test asserts every
# entry there has a matching .wasm on disk).

set -euo pipefail
cd "$(dirname "$0")/.."

RT="node_modules/web-tree-sitter/tree-sitter.wasm"
SRC="node_modules/tree-sitter-wasms/out"
DEST="assets/grammars"

# Mainstream languages with meaningful named entities (functions/classes/…),
# covering the set Entire's entire-sem supports and typical coursework.
GRAMMARS=(
  typescript tsx javascript
  python go rust java
  c cpp c_sharp
  ruby php swift kotlin scala
  lua bash
)

mkdir -p "$DEST"
cp "$RT" "$DEST/tree-sitter.wasm"
for g in "${GRAMMARS[@]}"; do
  cp "$SRC/tree-sitter-$g.wasm" "$DEST/tree-sitter-$g.wasm"
done

echo "Synced $(( ${#GRAMMARS[@]} + 1 )) wasm files into $DEST:"
ls -la "$DEST" | awk 'NR>1 {print "  " $5 "\t" $NF}'
