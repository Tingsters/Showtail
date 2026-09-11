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
Showtail connects the AI tools it finds and pre-wires integrations that are safe to configure
before their host exists. You never run a getting-started command — just work, then
`showtail report`. The first meaningful prompt creates the project-local trail; session
startup and isolated editor events do not. So there is no "Get started" group in
`showtail --help`.

## Maintain Showtail

| Command | What it does |
| ------- | ------------ |
| `update` | Check for and install the latest stable Showtail release. Downloads into a temporary file, verifies its release SHA-256 digest, and preserves the existing executable unless the replacement validates. Standalone installs update in place; source checkouts print pull/rebuild guidance instead. Flags: `--check` (do not install), `--auto-check <on\|off>` (persist the quiet-check preference), `--json`. |

Interactive, human-facing commands make a best-effort update check at most once
per day. A newer release is mentioned once when discovered and no more than once
per week afterwards. Hooks, capture commands, JSON output, CI, and piped commands
never perform or print passive checks. Set `SHOWTAIL_DISABLE_UPDATE_CHECK=1` for a
process-level opt-out.

## Manage tracking (optional)

| Command | What it does |
| ------- | ------------ |
| `setup` | Manage automatic creation of new project trails (enabled by installation). `--off` prevents hook-driven initialization but does not remove capture hooks or stop connected tools from writing to existing trails; use `disconnect <tool>` for that. Re-run `setup` to enable automatic creation again. Flags: `--off`, `--yes`, `--json`. |
| `track [path]` | Explicitly set up one project: name it (`-p, --project <name>`), declare a non-code folder (like a book) as a project, or recover already-captured work after a folder or file-only move (see [Moving a project](#moving-a-project)). Exact content lineage can be relocated even while the old trail folder still exists; copies and uncertain matches are never moved automatically. Safe to re-run and valid at any exact path, including HOME and temporary folders. An explicit nested trail defines its own boundary. Flags: `-p, --project <name>`, `--json` (includes `created`, `root`, `backfilled`, `claimedSessions`, and uncertain `candidates`). |
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
    still work — integrations can call `ensure`, and `start`/`end` give power users
    manual session control — but you never need them. `ensure` uses the same resolver as
    automatic capture, creates the trail if needed, and opens a session. It is idempotent
    and valid at any exact path, including HOME and temporary folders; a HOME trail is not
    inherited by descendants.

## Manual capture (optional)

Connected integrations already record routine prompts and edits. Use these commands only for
an event or snapshot you intentionally want to add; repeating automatic capture can create
duplicates.

| Command | What it does |
| ------- | ------------ |
| `log` | Add an optional event to the current session. Flags: `-t, --type <type>` (required), `-x, --text <text>` (or pipe via stdin), `-f, --files <files>`, `--tool <tool>`, `-s, --session <id>`, `--turn <id>`. |
| `artifact <file>` | Optionally snapshot a file's current state (hash, time, git commit). Flags: `-s, --session <id>`, `--tool <tool>`. |

## Review your trail

Human use stays convenient: omit the path to act on the project containing the current
directory. An AI agent should preserve the student's project wording and resolve it to a stable
trail ID before invoking a project command. The bare `showtail status --json --tool <tool>` startup
probe is intentionally different: it checks capture mode, not a user-requested project action.

```bash
showtail projects "<student-project-wording>" --json
showtail status --project "<trail-id>" --json --tool <tool>
showtail report --project "<trail-id>" --json --no-open
showtail verify --project "<trail-id>" --json
```

| Command | What it does |
| ------- | ------------ |
| `projects [selector]` | List the validated machine-local project catalog, or resolve a path, trail ID, configured/folder name, or exact complete-name phrase. JSON reports `selected`, `confirmation-required`, `ambiguous`, `conflict`, or `not-found` with evidence; it never scans the home directory. Flags: `--json`, `--verbose-json`. |
| `status [path]` | A read-only project, session, inbox, setup, and connected-tool snapshot that succeeds even before `.showtail/` exists. `--project <selector>` resolves a path, trail ID, or name and never falls back to cwd. Success JSON includes `trailId` and the selected `root`; a nonexistent explicit path returns `PATH_NOT_FOUND`. `--tool <tool>` adds `capture.mode` (`automatic`, `manual`, or `disconnected`). Flags: `--project <selector>`, `--json`, `--verbose-json`, `--tool <tool>`. |
| `sessions` | List your work sessions. Flags: `--all` (every contributor's), `--json`. |
| `capabilities` | The same read-only snapshot as `status`, plus agent-oriented commands and next-action guidance. Flags: `--json`, `--tool <tool>`. |
| `report [path]` | Generate a shareable report for the current or named project. `--project <selector>` resolves and locks the target before any write. Default command JSON is compact and returns the selected `trailId`, root, report paths, summary, and diagnostic counts; `--verbose-json` includes full routing and relocation arrays. Ambiguous/conflicting selection exits without creating a report. Other report, recovery, author/team, narration, sync, and open flags are unchanged. |
| `verify [path]` | Run integrity checks on the current or named trail. `--project <selector>` never falls back to cwd, and success JSON includes the selected `trailId` and root. Default JSON reports compact check counts; `--verbose-json` includes every check detail. Exits `3` if an integrity check fails. Flags: `--project <selector>`, `--json`, `--verbose-json`. |
| `trace <file>` | Show every snapshot and related event for a file. Flags: `--format <text\|json>` (default `text`). |

!!! note "Maintainer command"
    `showtail matrix` prints the integration capability matrix (`--json`, and the
    maintainer-only `--write-readme` / `--verify-live`). It's informational and hidden from
    `--help`, but still runnable.

## Manage the inbox

Work Showtail captured that isn't currently sitting in one project waits in the
**inbox** — because the host supplied no usable project path, one session touched
multiple projects and Showtail refused to guess, automatic tracking was off, or the
folder it *was* in has since moved or been deleted. Any exact writable folder can be
a project. By default the inbox shows work worth acting on; unresolved, low-signal,
explicitly ignored, and dismissed work is revealed with `--all`.

After a file-only move, work may still be placed in the old trail because that hidden
folder remains valid. `report <new folder>` and `track <new folder>` also inspect that
placed work for exact relocation evidence, so it does not have to appear in the inbox
before it can be recovered.

| Command | What it does |
| ------- | ------------ |
| `inbox` | List sessions awaiting placement; pick to place them, or dismiss (`d1,3` / `dismiss all`). Flags: `--all` (also show filtered work, tagged with why), `--json` (each session carries `pathGone`). |
| `ignore [path]` | Keep a folder's sessions out of the default `inbox` (still under `--all`). No path lists ignored folders. Flags: `--remove`, `--list`, `--json`. |
| `move [sessionId]` (alias `reattach`) | Move any captured session to another project folder. With no id, lists every session to pick from. If the session's files moved, its recorded paths are re-pointed at the new folder. Flags: `--to <path>`, `--json`. |

Sessions are tagged with why they appear:

| Tag | Meaning |
| --- | ------- |
| `[target missing]` | It *was* placed in a project, but that folder is gone. |
| `[files moved or deleted]` | The folder its files were captured in no longer exists. Shown in the default view, because it's actionable — see below. |
| `[unresolved: no project path]` | The host supplied no usable cwd, workspace, or edit path. `--all` only. |
| `[filtered: low signal]` | Too little in it to be worth placing. `--all` only. |
| `[filtered: ignored path]` | Under a folder you marked with `ignore`. `--all` only. |
| `[dismissed]` | You dismissed it. Reversible; `--all` only. |

### Moving a project

Moving or renaming the whole project folder — yourself, or by asking your AI tool to
do it — does not lose anything. The trail inside `.showtail/` travels with the folder,
and `report` refreshes its recorded location from the stable trail id.

If only the project files moved and `.showtail/` stayed at the old location, use either:

```text
showtail report <new folder>    # recover, then report
showtail track <new folder>     # recover without reporting
```

Showtail recognizes the work by its **content**: a byte-identical captured file or a
captured commit in the folder's history is Tier-A evidence and can relocate the session
automatically, including from a still-existing old trail. If the original files still
exist, the destination may be a copy, so the prior session is left alone. Tier-B
similarity, sessions spanning multiple projects, and a conclusive match that cannot safely
rebase every edited path also stop for review; Showtail never splits a session or
attributes it on a guess. Confirm an intended move with:

```text
showtail move <session-id> --to .
```

## Connect your tools

| Command | What it does |
| ------- | ------------ |
| `connect <tool>` | Connect an AI tool so your prompts and edits are captured (`claude`, `codex`, `copilot`, …). Flags vary by tool: `--user`, `--project`, `--no-hooks`, `--extension`, `--yes`, `--force`. Inapplicable flags are rejected loudly. |
| `disconnect <tool>` | Stop one tool's capture machine-wide and remove the user/current-project integration files Showtail can reach. The durable runtime stop makes stale hooks or extensions elsewhere no-op even when native removal fails. `--user` and `--project` are narrower removals and do not set that machine-wide stop. A capture-enabled `connect <tool>` clears it; `connect <tool> --no-hooks` does not. |
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

`showtail verify [path] --json` prints one JSON object on stdout (nothing else) and
keeps the same exit codes as the human output — `0` when every check passes, `3`
when any fails. It's the form to use in CI:

```json
{
  "ok": false,
  "root": "/absolute/path/to/project",
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
- `root` — the absolute project root whose trail was checked.
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
| `2` | No single project could be selected, the requested folder does not exist, captured work is ambiguous, or a relocation requires review. Nothing is created or guessed. |
| `3` | `verify` found a problem with the trail. |
| `4` | `report [path]` targeted a folder with no trail and no path or content-lineage match in captured work. Nothing is created. |

(A `ShowtailError` may set its own specific code; agents can branch on these.)
