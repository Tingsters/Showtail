# CLI reference

All generated data stays inside the folder printed by `showtail home`. User-level tool
registration is the exception: it must live in each host tool's own settings.

| Command | Purpose |
| --- | --- |
| `home [--open]` | Print or open the storage folder |
| `setup [--off] [--no-assistant]` | Enable or pause capture; optionally omit assistant reporting discovery |
| `connect <tool> [--no-hooks] [--no-assistant]` | Connect native collection; optionally omit callbacks or reporting discovery |
| `disconnect <tool>` | Stop automatic capture and remove user-level registration; keep history |
| `status [--tool <tool>]` | Show capture state, storage location, pending captures, and issues |
| `sync [--tool <tool>]` | Discover and ingest eligible native history through the current cutoff |
| `sessions [--project <id>] [--unassigned]` | List central conversations |
| `projects [selector]` | List or resolve project views |
| `projects add <path> [--name <name>]` | Register a view without changing its folder |
| `projects assign <session-or-turn-id> --to <project-ids...>` | Override membership as metadata |
| `projects relink <project-id> <path>` | Associate a moved folder; retain historical paths |
| `report [--project <selector> \| --session <id> \| --all]` | Generate a private report |
| `submit [--project <selector> \| --session <id> \| --all]` | Generate a sanitized, signed submission |
| `verify` | Check the central database, content hashes, and history chains |
| `verify-submission [directory]` | Verify an exported submission; default to the latest export |
| `import <tool> [source] [--file <path>]` | Import a provider conversation |
| `import legacy --from <path> [--from <path>] [--dry-run]` | Import old Showtail data without changing it |
| `start`, `log --text <text>`, `artifact <file>`, `end` | Explicit manual recording |
| `trace <file>` | Find captured edits to a file |
| `redact [--pattern <regex>] [--dry-run] [--yes]` | Rescan history; custom patterns preview unless `--yes` is supplied |
| `update [--check]` | Update or check the executable |

Report and submission selectors are mutually exclusive. `--session` is repeatable.
`--tool`, `--since`, and `--until` narrow report selections. Time selections retain whole
turns so replies keep their opening prompt. A shared turn may contain context from more
than one project; review selected work before sharing it.

Without a selector, reports use the current known project. Otherwise interactive runs ask
for a selection, and noninteractive/JSON runs return `SELECTION_REQUIRED` with candidates.
`--format html|md|json`, `--no-open`, `--no-sync`, and `--title` control private reports.

JSON control results use `schemaVersion: 2`, `home`, and optional `projectId` and
`projectRoot`. The project root is context; `reportPath` points into central storage.
The former `track`, `ensure`, `move`, and `inbox` placement workflow has been removed.

PR summaries require two separate operations:

```bash
showtail submit --project <id> --pr <url> --preview
showtail submit --pr --approve <code>
```

The preview shows the complete comment and withheld-value count. Approval posts only
that stored text, and fails if the report or selected history changed.

`import legacy --recover-damaged` explicitly recovers readable journal rows from a damaged source. Recovered records retain unverified legacy provenance and an audit record. Warnings identify skipped rows and chain breaks without printing their contents. Keep the original source bytes; normal imports continue to refuse damaged journals.
