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
| `track [path]` | Set up one project by hand: name it (`-p, --project <name>`), declare a non-code folder (like a book) as a project, and pull its already-captured work in — including work whose files have since **moved** (see [Moving a project](#moving-a-project)). Projects otherwise initialize automatically. Safe to re-run: a second run in an already-tracked folder still pulls in newly-orphaned work. Flags: `-p, --project <name>`, `--json` (emits `backfilled` and `candidates`). |
| `migrate [tool]` | Enrich older trails from the AI tools' retained local transcripts. Recovers missing replies, edits, plans, decisions, tool calls/results, models, and recap statistics without rewriting existing journal lines. With no tool, checks every supported local provider. Flags: `-s, --session <id>`, `--file <path>` (requires a tool), `--dry-run`, `-y, --yes`, `--json`, `--resume <run-id>`. `showtail migrate undo [batch-id]` removes a migration batch and records the declared rewrite for `verify`. |
| `redact` | Scrub a secret the write-time rules missed out of an already-captured trail, instead of deleting `.showtail/`. `--rescan` re-runs the project's current rules (including a `settings.redact.custom` added since capture) over every stored object, preview, and plan file; `--pattern <regex>` scrubs one specific value — a **preview until you pass `--yes`**. Rewrites the content to its new address, repoints the journal, deletes the old object, re-links the hash chain, and records a dated redaction marker `verify` reports. Flags: `--rescan`, `--pattern <regex>`, `--dry-run`, `-y, --yes`, `--json`. See [Privacy &amp; redaction](../concepts/privacy.md#if-something-leaked-anyway). |

### Migrating older trails

On the first interactive run after a history-generation upgrade, Showtail offers
once to scan your home directory for existing project trails. If accepted, it
shows a project/session preview, migrates every conclusive match after one final
confirmation, and asks separately about ambiguous transcript matches. Declining
the offer dismisses it permanently; migrate an individual missed project later by
running `showtail migrate` inside it.

Migration is append-only. Recovered events keep the provider's original time and
ordering, while a separate audit record says when the recovery happened and which
transcript digest supplied it. Absolute transcript paths are not committed. The
current project capture and redaction settings still apply.

!!! note "Hidden lifecycle commands"
    Tracking is automatic, so `ensure` (init + open a session), `start` (begin a
    session, `-l, --label`), and `end` (close a session) are hidden from `--help`. They
    still work — the editor extension calls `ensure` on project open, and `start`/`end`
    give power users manual session control — but you never need them.

## Maintain Showtail

| Command | What it does |
| ------- | ------------ |
| `upgrade` | Upgrade a standalone installer build to the latest GitHub Release without re-running the installer. Downloads and verifies the matching binary, updates the bundled editor extension, and refreshes capture integrations. Bun/source-managed copies are left untouched and must be updated through their original workflow. Flags: `--json`. |

## Capture your work

| Command | What it does |
| ------- | ------------ |
| `log` | Record an event (usually a prompt) in your current session. Flags: `-t, --type <type>` (required), `-x, --text <text>` (or pipe via stdin), `-f, --files <files>`, `--tool <tool>`, `-s, --session <id>`, `--turn <id>`. |
| `artifact <file>` | Snapshot a file's current state (hash, time, git commit). Flags: `-s, --session <id>`, `--tool <tool>`. |

## Review your trail

| Command | What it does |
| ------- | ------------ |
| `status` | Your current session and connected tools at a glance. Also notices when this project has **moved** since it was last seen and updates its recorded location (and warns if the folder looks *copied* rather than moved — two folders sharing one trail id). Flags: `--json`. |
| `sessions` | List your work sessions. Flags: `--all` (every contributor's), `--json`. |
| `capabilities` | Report this folder's tracking state and what to do next (for AI agents). Flags: `--json`. |
| `report` | Generate a shareable report. Like `status`, it refreshes this project's recorded location if it has moved. A combined **team** report is written only when the project has **two or more** contributors; a solo project gets a single report. After writing, an interactive menu offers to open the report (**once / always / never**, Esc to skip); *always*/*never* is remembered in `~/.showtail-cli/config.json`. Flags: `--format <html\|md\|json>` (default `html`), `--ai <collapsed\|full\|off>` (how much AI narration to show; `--no-ai` = off), `--open` (open without asking), `--no-open` (don't open or prompt), `--ask` (show the menu, ignoring a remembered choice), `--author <slug>`, `--team`, `--title <text>`, `--json`, `--no-sync`. Before rendering, `report` re-reads your AI tool's own transcript to fold in anything the live hooks couldn't see — a host writes its transcript asynchronously and appends each turn's recap minutes later, so a session's final exchange has no hook left to capture it. The sweep only adds what's missing (repeat runs change nothing); `--no-sync` skips it. |
| `verify` | Run integrity checks on your trail: config, journal entry validity, the journal **hash chain**, stored content vs. its content address, file snapshots, path portability, and report generation. Exits `3` if a check fails. Flags: `--json`. |
| `trace <file>` | Show every snapshot and related event for a file. Flags: `--format <text\|json>` (default `text`). |

!!! note "Maintainer command"
    `showtail matrix` prints the integration capability matrix (`--json`, and the
    maintainer-only `--write-readme` / `--verify-live`). It's informational and hidden from
    `--help`, but still runnable.

## Manage the inbox

Work Showtail captured that isn't currently sitting in a project waits in the
**inbox** — either because it had no project to go to (folderless / scratch
sessions), or because the folder it *was* in has since moved or been deleted. By
default the inbox shows work worth acting on; low-signal and scratch work is kept
aside and revealed with `--all`.

| Command | What it does |
| ------- | ------------ |
| `inbox` | List sessions awaiting placement; pick to place them, or dismiss (`d1,3` / `dismiss all`). Flags: `--all` (also show scratch kept aside, tagged with why), `--json` (each session carries `pathGone`). |
| `ignore [path]` | Mark a folder as scratch so its sessions stay out of the default `inbox` (still under `--all`). No path lists ignored folders. Flags: `--remove`, `--list`, `--json`. |
| `move [sessionId]` (alias `reattach`) | Move any captured session to another project folder. With no id, lists every session to pick from. If the session's files moved, its recorded paths are re-pointed at the new folder. Flags: `--to <path>`, `--json`. |

Sessions are tagged with why they appear:

| Tag | Meaning |
| --- | ------- |
| `[target missing]` | It *was* placed in a project, but that folder is gone. |
| `[files moved or deleted]` | The folder its files were captured in no longer exists. Shown in the default view, because it's actionable — see below. |
| `[scratch: not in a project]` | Captured somewhere that isn't a project folder. `--all` only. |
| `[scratch: low-signal]` | Too little in it to be worth placing. `--all` only. |
| `[scratch: ignored path]` | Under a folder you marked with `ignore`. `--all` only. |
| `[dismissed]` | You dismissed it. Reversible; `--all` only. |

### Moving a project

Moving or renaming a project folder — yourself, or by asking your AI tool to do
it — does not lose anything. The trail inside `.showtail/` travels with the folder,
and everything captured is also held in a machine-local ledger.

To pick the work back up at the new location:

```text
showtail track <new folder>
```

Showtail recognizes the work by its **content** (a matching file, or a captured
commit in the folder's history), not by the old path — so it still finds it after a
move. When the evidence is conclusive it places the work for you; when it's only a
strong resemblance it lists the sessions and leaves them alone, so nothing is ever
attributed to the wrong project on a guess. Place one of those yourself with:

```text
showtail move <session-id> --to .
```

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

## `verify --json`

`showtail verify --json` prints one JSON object on stdout (nothing else) and
keeps the same exit codes as the human output — `0` when every check passes, `3`
when any fails. It's the form to use in CI:

```json
{
  "ok": false,
  "checks": [
    {
      "name": "journal chain is unbroken",
      "ok": false,
      "details": [
        "ada-at-example-com/9f3c… entry 12 (evt_lqz3k8_a1b2): the entry before it does not match this entry’s recorded link — the journal was edited after it was written."
      ]
    },
    {
      "name": "file snapshots are accounted for",
      "ok": true,
      "details": ["edited  src/main.py", "1 file(s) edited since their last snapshot — expected if you kept working."]
    },
    {
      "name": "journal history is append-only (git)",
      "ok": true,
      "skipped": "shallow-clone",
      "details": ["NOT VERIFIED: this is a shallow clone, …"]
    }
  ]
}
```

- `ok` — true only when every check passed.
- `checks[]` — one entry per check, in the order the human output prints them,
  each with a stable `name`, its own `ok`, and human-readable `details` lines.
- `skipped` — present only when a check could not examine anything, set to a
  short stable slug saying why: `no-git`, `no-journal`, `journal-ignored`,
  `shallow-clone`, `not-committed`, `journal-not-text`. Such a check still
  reports `ok: true` (it found nothing wrong, and a student working without git
  must not be told their trail failed) — but **"nothing to check" is not
  "checked and fine"**. Branch on `name`, `ok` and `skipped`; treat `details` as
  human text that may be reworded and never parse it.

`details` text may be reworded between releases; branch on `ok` and `name`.

One check, `journal history is append-only (git)`, reads the project's git
history: the journal only ever grows, so a commit that *removes* journal lines
is a rewrite, and it fails unless a `showtail redact` / `showtail import undo`
marker in the trail declares it. It never fails for the absence of git — no
repo, or a trail not committed, is reported as information. A **shallow** clone
is reported as *not verified* rather than passed, so run it against a full
checkout (`fetch-depth: 0`); see
[Verify submissions in CI](../educators/verify-in-ci.md).

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success. |
| `1` | General error. |
| `2` | Not initialized (run `showtail track`, or just start working with a connected tool). |
| `3` | `verify` found a problem with the trail. |

(A `ShowtailError` may set its own specific code; agents can branch on these.)
