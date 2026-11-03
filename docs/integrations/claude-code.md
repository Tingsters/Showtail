# Claude Code integration

Run `showtail connect claude` to install the user-level skill and lifecycle hooks.
They live under `~/.claude` (or `CLAUDE_CONFIG_DIR`); project files are untouched.
The packaged Claude plugin is another way to register the same hooks.

Prompts, edits, replies, plans, and supported structured conversation records enter
`~/.showtail/history.sqlite`. Use `showtail status --json --tool claude` to inspect
capture. `showtail connect claude --no-hooks` uses on-demand native imports;
`showtail disconnect claude` stops capture. `showtail setup --off` pauses all tools.

Capture settings belong in Showtail's central `config.json`, including
`settings.captureToolCalls`, `settings.captureAiOutput`, and `settings.captureCode`.
Secrets are redacted before storage; tool output is withheld by default.

To import existing sessions, run `showtail import claude --list`, then
`showtail import claude <session-id>`. Imports are local and repeatable. Reports
discover eligible native conversations and catch up through the report cutoff.
Pre-consent history still requires an explicit import. Routine capture needs no model
instructions. See [passive capture](../concepts/passive-capture.md).

See [data layout](../concepts/data-layout.md) and [privacy](../concepts/privacy.md).
