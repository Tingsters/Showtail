# OpenAI Codex integration

Run `showtail connect codex` to install a deferred reporting skill and observer hooks
under `~/.codex` (or `CODEX_HOME`). It enables `features.hooks` in that home's
`config.toml`. It does not write project instructions, ignore rules, or Git hooks.

Current Codex releases require you to review and trust the exact callback definitions
in Codex's `/hooks` screen. Showtail never grants that trust itself. New or changed
callbacks remain on-demand until the host confirms they are enabled and trusted.
While reviewing them, `showtail sync --tool codex` can collect eligible saved history.

`showtail status --json --tool codex` checks the host's read-only `hooks/list` API.
It separates `hooksConfigured` from `hooksActive` and reports `HOOK_TRUST_REQUIRED`
when review is needed. An unavailable or older host that cannot verify callbacks
reports `HOOK_STATE_UNAVAILABLE` rather than claiming automatic capture.
With automatic capture,
work normally: prompts, file diffs, replies, plans, and supported decisions enter
the central history. Codex app-server reads are supplemented by the exact session's
rollout when needed. Another session's newest rollout is never substituted.

Use `showtail connect codex --no-hooks` for on-demand native collection,
or `showtail disconnect codex` to stop capture. Existing history stays available.

Import older sessions explicitly with `showtail import codex --list` and
`showtail import codex <session-id>`. All reports and imports live in Showtail's
[data folder](../concepts/data-layout.md), independently of the working directory.
`--no-assistant` omits the reporting skill independently of collection. There are no
startup commands or standing AGENTS instructions. See [passive capture](../concepts/passive-capture.md).
