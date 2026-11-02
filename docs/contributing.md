# Contributing and development

Use Bun to install dependencies, run checks, and compile the CLI:

```bash
bun install
bun run typecheck
bun test
bun run verify:integrations
bun run build
```

Tests isolate Showtail and tool homes under temporary directories. Provider fixtures
exercise normalized capture without contacting AI accounts. The central tests check
content integrity, contention replay, consent boundaries, explicit migration, signed
exports, and byte-for-byte project preservation. Provider fixture verification is
not a claim that a live vendor integration was exercised.

The VS Code extension has separate dependencies and checks in `integrations/vscode`:
`bun install`, `bun test`, `bun run typecheck`, and `bun run build`. Its extension-host
suite additionally requires a usable editor environment.

Use an isolated absolute `SHOWTAIL_HOME` when developing. Never point tests at your
personal history. Legacy fixtures are read-only inputs. Update the capability table
with `bun run scripts/update-matrix.ts` after changing capability metadata.

Documentation uses MkDocs; see `mkdocs.yml`. Changes are licensed under Apache-2.0.
