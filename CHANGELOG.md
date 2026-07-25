# Changelog

## Unreleased

### Before tagging this release

- **Point a `v1` tag at it.** `docs/educators/verify-in-ci.md` tells educators to use
  `Tingsters/Showtail@v1`, and no `v1` tag exists (releases are tagged `v0.x`). The
  GitHub Action is also inert until a release contains `verify --json` — v0.12.0 does
  not, and fails with `unknown option '--json'`. Remove the "Not usable until the next
  release" warning on that page once both are true.

### What changed

- **`showtail verify` now verifies that the trail is *unmodified*.** Two new checks:
  the journal is **hash-chained** (every entry carries `prev`, the SHA-256 of the line
  before it in that author+machine shard, so an edited, deleted, or spliced-in line
  breaks the chain at the next line), and **stored content is re-hashed against its
  content address** (an edited object in `.showtail/objects/` no longer matches the
  name it's filed under — this is what catches an invented prompt, since prompt and
  AI-response text lives there). No keys, no service, nothing to configure.
- **Editing your own code after a snapshot no longer fails verification.** It was
  reported as an error, which had the tool exactly backwards: a student who kept
  working failed, while one who hand-edited their journal passed. "N file(s) edited
  since their last snapshot" is now informational, a recorded file that's since been
  moved or deleted is a warning, and failure is reserved for the trail itself being
  modified. Trails written before chaining report their entries as *unchained*
  (informational), never as tampering.
- **`showtail verify --json`** prints the structured result (`{ ok, checks: [{ name,
  ok, details }] }`) for CI, keeping the existing exit code `3` on failure.
- **A GitHub Action (`Tingsters/Showtail@v1`)** verifies a submission's trail on every
  push. An educator adds two lines to an assignment template repo and each student's
  trail is checked automatically, with a pass/fail summary in the Checks tab. Inputs:
  `path`, `version`, `fail-on-invalid`; outputs: `ok`, `checks-json`. It installs into
  `RUNNER_TEMP` and disables the first-run bootstrap, so it never wires capture hooks
  into the runner. See [Verify submissions in CI](docs/educators/verify-in-ci.md).

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
