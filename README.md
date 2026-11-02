<p align="center"><img src="assets/showtail-logo.png?v=2" alt="Showtail" width="520"></p>

# Showtail

**Show your work.** Showtail automatically records the prompts you send to AI tools,
the choices you make, and the files you change. Review your process privately, then
create a sanitized report to hand in.

Everything stays in **`~/.showtail/`**, or the directory selected by `SHOWTAIL_HOME`.
Showtail does not create files in your projects, alter their Git hooks, or require a
project before it can capture work. Projects are optional views of one personal history.
There are no accounts, cloud storage, or telemetry.

```bash
showtail setup                    # connect tools for this user and enable capture
# Work normally with your AI tool.
showtail report                   # private report for the current project
showtail submit                   # sanitized, signed submission
showtail home --open              # find your stored history and generated reports
```

Outside a known project, select a conversation with `--session <id>` or deliberately
include everything with `--all`. Reports and submissions are saved inside Showtail's
folder. Nothing is uploaded automatically; PR comments require a preview and approval.

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
```

The installers register user-level tool connections. Those connections necessarily
live in the tools' own settings; captured history and Showtail state remain together.
Disconnect a tool with `showtail disconnect <tool>`, or pause automatic capture with
`showtail setup --off`. Disconnecting preserves your history.

## Supported tools

Claude Code, Codex, Copilot CLI, and Antigravity use host hooks or readable transcripts.
VS Code Copilot and Antigravity IDE use the Showtail editor extension. ChatGPT and
Gemini conversations can be imported from public share links or saved conversations.
Support depends on what each host exposes; fixture tests do not certify a live host release.

## Moving from the old project format

This is a breaking storage redesign. Old data is never moved or imported automatically.
Preview and import an old machine ledger and selected project trails together:

```bash
showtail import legacy --from /path/to/.showtail-cli --from /path/to/project --dry-run
showtail import legacy --from /path/to/.showtail-cli --from /path/to/project
```

The importer deduplicates ledger records and project copies, preserves provenance,
and leaves originals untouched. Old project files and instruction blocks may be removed
manually after reviewing the import. An existing legacy `~/.showtail` requires an
alternate `SHOWTAIL_HOME`; Showtail refuses to overwrite it.

[Documentation](https://tingsters.github.io/Showtail/) ·
[CLI reference](docs/reference/cli.md) · [Privacy](docs/concepts/privacy.md)

## Development

Built with TypeScript and Bun. Run `bun test`, `bun run typecheck`, and `bun run build`.
The transcript-reading package remains usable independently of the central Bun/SQLite store.

[Apache-2.0](LICENSE). Releases include [third-party notices](THIRD_PARTY_NOTICES.md).

## Code signing policy

See the [code signing policy](docs/code-signing-policy.md) for signing, release roles, and verification. Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
