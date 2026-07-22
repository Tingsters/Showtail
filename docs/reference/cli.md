# CLI reference

Every Showtail command, grouped the way `showtail --help` shows them. Run
`showtail <command> --help` for the authoritative, up-to-date flag list.

```text
showtail <command> [options]
```

Global flags: `-v, --version` prints the version. Most commands accept `--json`
for machine-readable output (noted below).

## Getting started — nothing to run

Tracking turns on **when you install** (see [Installation](../getting-started/installation.md)):
Showtail connects the AI tools it finds and pre-wires the ones it supports, so a tool you
install later is captured too. You never run a getting-started command — just work, then
`showtail report`. So there is no "Get started" group in `showtail --help`.

## Manage tracking (optional)

| Command | What it does |
| ------- | ------------ |
| `setup` | Manage automatic tracking (it turns on by itself after install). `--off` turns it off; re-run to turn it back on. Flags: `--off`, `--yes`, `--json`. |
| `track [path]` | Set up one project by hand: name it (`-p, --project <name>`), declare a non-code folder (like a book) as a project, and pull its already-captured work out of the inbox. Projects otherwise initialize automatically. Flags: `-p, --project <name>`, `--json`. |

!!! note "Hidden lifecycle commands"
    Tracking is automatic, so `ensure` (init + open a session), `start` (begin a
    session, `-l, --label`), and `end` (close a session) are hidden from `--help`. They
    still work — the editor extension calls `ensure` on project open, and `start`/`end`
    give power users manual session control — but you never need them.

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
| `report` | Generate a shareable report. A combined **team** report is written only when the project has **two or more** contributors; a solo project gets a single report. After writing, an interactive menu offers to open the report (**once / always / never**, Esc to skip); *always*/*never* is remembered in `~/.showtail-cli/config.json`. Flags: `--format <html\|md\|json>` (default `html`), `--ai <collapsed\|full\|off>` (how much AI narration to show; `--no-ai` = off), `--open` (open without asking), `--no-open` (don't open or prompt), `--ask` (show the menu, ignoring a remembered choice), `--author <slug>`, `--team`, `--title <text>`, `--json`. |
| `verify` | Run integrity checks on your trail (config, journal, artifact hashes, report). |
| `trace <file>` | Show every snapshot and related event for a file. Flags: `--format <text\|json>` (default `text`). |

!!! note "Maintainer command"
    `showtail matrix` prints the integration capability matrix (`--json`, and the
    maintainer-only `--write-readme` / `--verify-live`). It's informational and hidden from
    `--help`, but still runnable.

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
