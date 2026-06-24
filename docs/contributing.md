# Contributing &amp; development

Showtail is built with TypeScript on the [Bun](https://bun.sh) runtime. It keeps
dependencies small: `commander` for the CLI and `turbo-stream` for decoding
shared-chat transcripts, with hashing and git handled through the standard
library.

## Build &amp; test

```bash
bun install
bun test            # Run the test suite
bun run typecheck   # tsc --noEmit
bun run dev -- --help
bun run build       # Compile a standalone binary to dist/showtail
```

## Working on the docs site

The documentation site is built with [MkDocs](https://www.mkdocs.org/) and
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/). It is
published to GitHub Pages by `.github/workflows/docs.yml` on every push to `main`
that touches `docs/`, `mkdocs.yml`, or that workflow.

Preview it locally:

```bash
pip install -r docs/requirements.txt
mkdocs serve          # live preview at http://127.0.0.1:8000
mkdocs build --strict # what CI runs; fails on broken internal links
```

The [capability matrix](integrations/index.md) on the integrations page is
generated from `src/core/capabilityMatrix.ts` (the single source of truth). It
lives inside a managed `<!-- showtail:start --> … <!-- showtail:end -->` block —
do not edit it by hand. Regenerate it after changing the data model with:

```bash
bun run src/cli.ts matrix --write-readme
```

(The flag is named `--write-readme` for historical reasons; it now writes the
managed block on `docs/integrations/index.md`.)

## License

[Apache-2.0](https://github.com/Tingsters/Showtail/blob/main/LICENSE)
