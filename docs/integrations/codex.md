# OpenAI Codex integration

Run `showtail connect codex` to install user-level instructions and lifecycle hooks
under `~/.codex` (or `CODEX_HOME`). It enables `features.hooks` in that home's
`config.toml`. It does not write project instructions, ignore rules, or Git hooks.

`showtail status --json --tool codex` reports capture mode. With automatic capture,
work normally: prompts, file diffs, replies, plans, and supported decisions enter
the central history. Codex app-server reads are supplemented by the exact session's
rollout when needed. Another session's newest rollout is never substituted.

Use `showtail connect codex --no-hooks` for instructions without automatic capture,
or `showtail disconnect codex` to stop capture. Existing history stays available.

Import older sessions explicitly with `showtail import codex --list` and
`showtail import codex <session-id>`. All reports and imports live in Showtail's
[data folder](../concepts/data-layout.md), independently of the working directory.
