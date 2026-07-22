# Changelog

## Unreleased

### What changed

- **`showtail report` now offers to open the report on every platform.** The printed
  path was a clickable hyperlink only in terminals that support OSC 8 (Windows
  Terminal, iTerm2, VS Code); macOS Terminal.app has no such support, so the link was
  inert there. Instead of depending on the terminal, `report` now shows a one-keypress
  menu after writing — **(o)nce / (a)lways / (n)ever** (Esc or Ctrl-C to skip) — and
  opens the report in your default browser. *Always*/*never* is remembered per-user in
  `~/.showtail-cli/config.json`; `--open` opens without asking, `--no-open` suppresses
  it, and `--ask` re-shows the menu to change a remembered choice. When several reports
  were written the menu lists them so you can pick which to open.
- **A combined "team" report is only written when there are multiple contributors.**
  A solo project previously got a redundant `report-team-*` alongside its single
  contributor report; now it just gets the one.

## 0.12.0 — Readable reports: student-first layout + exchanges toolbar

### What changed

- **The report foregrounds the student's work.** Each exchange shows the prompt,
  decisions, plans, and code/diffs inline; **all** of the AI's prose is collapsed
  into per-run **"🤖 N messages"** pills placed **in chronological position** within
  the turn. Expanding them (or the page toggle) reconstructs the full "what happened
  and where" narrative — AI reasoning interleaved with the edits/decisions, in order,
  with nothing duplicated. The rule is uniform across every tool (no content
  guessing), so it behaves the same for Claude, Codex, Gemini, and imports.
- **A sticky exchanges toolbar** sits under the "Prompts & AI exchanges" heading:
  **Expand / Collapse all**, an **AI messages** show/hide switch (persisted), and a
  **Sort: Time | Session** control — *Time* is one chronological stream; *Session*
  groups each AI conversation together (for parallel/interleaved workflows), and
  re-clicking the active mode reverses order. Progressive-enhanced: with JS off the
  report still reads top-to-bottom.
- **`showtail report --ai <collapsed|full|off>`** (`--no-ai`) sets the AI-visibility
  default for a generated file; the summary line now leads with tasks + files changed.
- **Injected harness content is no longer captured as prompts.** Background-subagent
  `<task-notification>` results, `<system-reminder>` context, and Claude Code's
  context-compaction summary (`isCompactSummary`) were being recorded as giant
  "prompts"; they're now filtered at capture and healed in existing trails at report
  time (no migration).

## 0.11.1 — `showtail move`

- **`showtail move`** relocates a captured session from one project folder to
  another. With no arguments it lists *every* ledger session — its `led_…` id and
  current folder (`→ <path>`, `[inbox]`, or `[target missing]`) — and lets you pick
  one to move. `showtail move <id> --to <path>` is the scriptable form, and
  `showtail move --json` lists everything for scripts/agents. `reattach` is now an
  alias of `move`. (Only sessions captured on 0.11+ are movable; pre-upgrade
  history lives only in its repo trail.)

## 0.11.0 — Durable capture ledger + per-machine sessions

### What changed
- **Durable capture ledger.** Every coding session is now recorded in a
  machine-local ledger (`~/.showtail-cli/ledger/`) *before* it's routed to a
  project. Folderless / scratch-workspace / global-agent sessions that used to be
  dropped now land in **`showtail inbox`**, and you can place or move them with
  **`showtail reattach <session> --to <path>`**.
- **Sessions are now per-machine.** Session metadata moved from a single
  `authors/<slug>/sessions.json` to per-machine shards
  `authors/<slug>/sessions/<machineId>.json` — the same trick the journal already
  uses — so two people (or one person on two machines) sharing a repo never hit a
  git merge conflict on sessions.
- **Trail id.** Each trail gets a stable `trailId` in `.showtail/config.json`
  (config schema **v3 → v4**), so a moved repo is recognized and a deleted one is
  reattachable.
- **Repo trail is now a projection of the ledger** (the capture path was inverted).
  The on-disk journal/objects/reports format is unchanged.

### Migration — automatic, nothing to run
Existing trails upgrade **in place on first use**: the config is bumped to v4 with a
`trailId`, and a legacy `sessions.json` is folded into this machine's shard (so old
sessions remain readable and can be closed). Your events, objects, plans, and reports
are untouched.

### ⚠️ Upgrading a SHARED repo? Upgrade together.
Sessions written by 0.11+ live in `sessions/<machineId>.json`, which **older Showtail
versions cannot read** — they'll still show every prompt/edit (those come from the
journal) but may miss session metadata until upgraded. If multiple collaborators share
one `.showtail/` trail, have everyone move to 0.11+ around the same time. (A repo
written by a newer Showtail than your binary now prints a heads-up in
`showtail status` / `showtail verify`.)

### Notes
- The ledger captures from the upgrade onward; work captured before upgrading stays in
  its repo trail (it just won't appear in `showtail inbox`).
- Escape hatch: `SHOWTAIL_LEDGER_WRITER=0` restores the legacy direct-write capture
  path if you need it.
