# CLI reference

Every Showtail command, grouped the way `showtail --help` shows them. Run
`showtail <command> --help` for the authoritative, up-to-date flag list.

```text
showtail <command> [options]
```

Global flags: `-v, --version` prints the version. Most commands accept `--json`
for machine-readable output (noted below).

## Get started

| Command | What it does |
| ------- | ------------ |
| `setup` | One-time guided setup: connect your AI tools and turn on automatic tracking. Flags: `--off` (turn tracking back off), `--yes` (no prompts), `--json`. |
| `track [path]` | Track a folder as a Showtail project (creates `.showtail/`) and pull its already-captured work out of the inbox. Any folder works — it need not be a code repo. Flags: `-p, --project <name>`, `--json`. |
| `ensure` | Make sure this project is initialized and a session is open (safe to re-run; this is what the hooks call). Flags: `--json`. |
| `start` | Begin a new work session. Flags: `-l, --label <label>`, `--json`. |
| `end` | Close the current work session. Flags: `--json`. |

!!! tip "You rarely need `track` or `start`"
    Once a tool is connected, Showtail initializes the project and opens a
    session automatically the first time you work. `track`/`start` are for wiring
    things up by hand (or to declare a non-code folder — like a book — as a project).

## Capture your work

| Command | What it does |
| ------- | ------------ |
| `log` | Record an event (usually a prompt) in your current session. Flags: `-t, --type <type>` (required), `-x, --text <text>` (or pipe via stdin), `-f, --files <files>`, `--tool <tool>`, `-s, --session <id>`, `--turn <id>`. |
| `artifact <file>` | Snapshot a file's current state (hash, time, git commit). Flags: `-s, --session <id>`, `--tool <tool>`. |

## Review your trail

| Command | What it does |
| ------- | ------------ |
| `status` | Your current session and connected tools at a glance. Flags: `--json`. |
| `sessions` | List your work sessions. Flags: `--all` (every contributor's), `--json`. |
| `capabilities` | Report this folder's tracking state and what to do next (for AI agents). Flags: `--json`. |
| `matrix` (alias `integrations`) | Show the integration capability matrix. Flags: `--json`. (Maintainer-only: `--write-readme`, `--verify-live`.) |
| `report` | Generate a shareable report. Flags: `--format <html\|md\|json>` (default `html`), `--open`, `--author <slug>`, `--team`, `--title <text>`, `--json`. |
| `verify` | Run integrity checks on your trail (config, journal, artifact hashes, report). |
| `trace <file>` | Show every snapshot and related event for a file. Flags: `--format <text\|json>` (default `text`). |

## Manage the inbox

Work Showtail captured but couldn't place in a project (folderless / scratch sessions) waits in the **inbox**. By default only real-project, signal-bearing work shows; the rest is kept aside (recoverable).

| Command | What it does |
| ------- | ------------ |
| `inbox` | List real-project sessions awaiting placement; pick to place them, or dismiss (`d1,3` / `dismiss all`). Flags: `--all` (also show scratch kept aside, tagged with why), `--json`. |
| `ignore [path]` | Mark a folder as scratch so its sessions never surface in `inbox` (still under `--all`). No path lists ignored folders. Flags: `--remove`, `--list`, `--json`. |
| `move [sessionId]` (alias `reattach`) | Move any captured session to another project folder. With no id, lists every session to pick from. Flags: `--to <path>`, `--json`. |

## Connect your tools

| Command | What it does |
| ------- | ------------ |
| `connect <tool>` | Connect an AI tool so your prompts and edits are captured (`claude`, `codex`, `copilot`, …). Flags vary by tool: `--user`, `--project`, `--no-hooks`, `--extension`, `--yes`, `--force`. Inapplicable flags are rejected loudly. |
| `disconnect <tool>` | Remove a tool's instructions/skill and any auto-capture hooks. Flags: `--user`, `--project` (default). |
| `import <tool> [source]` | Import conversations from another tool into your trail. Subcommands below. |
| `import undo` | Undo the most recent import (permanently removes that batch of events). |

### `import` subcommands

Share-based tools (**`chatgpt`**, **`gemini`**) accept a share URL or a paste:

`--no-responses` · `--paste` · `--clipboard` · `-y, --yes` · `--file <path>` ·
`--date <yyyy-mm-dd>` · `-s, --session <id>`

Transcript-based tools (**`claude`** / alias `claude-code`, **`codex`**) read an
on-disk transcript:

`--list` · `--no-responses` · `--file <path>` · `-s, --session <id>`

See each tool's [integration guide](../integrations/index.md) for worked
examples.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success. |
| `1` | General error. |
| `2` | Not initialized (run `showtail track`, or just start working with a connected tool). |
| `3` | `verify` found a problem with the trail. |

(A `ShowtailError` may set its own specific code; agents can branch on these.)
