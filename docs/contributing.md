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
bun run license:check # Audit licenses of distributed components
bun run dev -- --help
bun run build       # Compile a standalone binary to dist/showtail
```

## Local Docker test environment

Build and run the current checkout in an isolated Linux sandbox with the
standalone Showtail binary, Claude Code, and Codex installed:

```bash
./scripts/docker-test.sh --version
./scripts/docker-test.sh shell
```

The runner rebuilds the image on each invocation. Agent configuration and login
state persist in the named volume `showtail-test-home`; scratch projects and
their `.showtail/` trails persist in `showtail-test-workspace`. Enter `shell` to
exercise a complete workflow without touching this checkout:

```bash
./scripts/docker-test.sh shell
mkdir demo && cd demo
showtail track --project "Docker Test"
claude                    # or: codex
showtail report --no-open
showtail verify
```

On first use, the runner copies only recognized host authentication files into
the private Docker home when they exist: `.claude.json`,
`.claude/.credentials.json`, and `.codex/auth.json`. It does not copy Claude's
`settings.json`, Codex's `config.toml`, transcripts, hooks, custom providers, or
wrappers. Authenticate inside the persistent sandbox when no reusable credential
is available:

```bash
./scripts/docker-test.sh login claude
./scripts/docker-test.sh login codex       # device-code login
# Or, after exporting OPENAI_API_KEY from your secret manager:
./scripts/docker-test.sh login codex       # API-key login when the variable is set
```

The API key is piped to `codex login` over stdin rather than placed in the
container command line. Remove both volumes, including their copied login state,
when you want a completely clean machine:

```bash
./scripts/docker-test.sh clean
```

Override the image, volumes, or deterministic test identity with
`SHOWTAIL_DOCKER_IMAGE`, `SHOWTAIL_DOCKER_HOME_VOLUME`,
`SHOWTAIL_DOCKER_WORKSPACE_VOLUME`, `SHOWTAIL_DOCKER_IDENTITY_NAME`, and
`SHOWTAIL_DOCKER_IDENTITY_EMAIL`.

The live runner drives the real Claude Code and Codex CLIs through the existing
capture harness. Check installation and authentication without using model quota:

```bash
./scripts/docker-live-test.sh --check
```

Run the actual live regression only when consuming Claude and Codex quota is
intentional:

```bash
./scripts/docker-live-test.sh
```

The live run uses throwaway projects and does not update
`matrix-verification.json`; run the normal maintainer certification command when
the verification ledger itself needs to be refreshed.

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

Unless a contribution is explicitly marked otherwise before it is submitted,
submitting it for inclusion in Showtail means it is provided under Apache-2.0,
as described by section 5 of the license. Do not contribute code, assets, or
generated output that you do not have permission to license on those terms.

Release binaries include the Bun runtime and other Open Source components. See
[`THIRD_PARTY_NOTICES.md`](https://github.com/Tingsters/Showtail/blob/main/THIRD_PARTY_NOTICES.md)
for their licenses, source locations, and the Bun/WebKit relinking path.
