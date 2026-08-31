# Changelog

## Unreleased

## 0.15.0 — Recover and export complete AI work

### Added

- **JSON reports now include provider-neutral structured conversation events.**
  Schema v2 preserves visible text, tool calls and correlated results, questions
  and answers, plans and approvals, shell channels, edits, agents, and background
  completions across transcript-backed integrations. Existing human reports and
  counts stay unchanged, and legacy trails receive deterministic best-effort
  events without fabricated tool data.
- **Older trails can recover the transcript detail newer Showtail versions know
  how to capture.** `showtail migrate` matches existing sessions to local Claude
  Code, Codex, Antigravity CLI/IDE, Copilot CLI, and Copilot Chat transcripts,
  then append-only recovers missing replies, edits, plans, decisions, models,
  tool calls/results, and recap statistics. `--dry-run` previews, `--json`
  supports automation, and `showtail migrate undo` removes a batch with a
  declared verification marker.
- **A one-time upgrade offer can migrate every eligible project.** Existing
  generation-1 installs are offered a consented home scan, one bulk preview, and
  one confirmation. Fresh installs are not prompted; noninteractive upgrades
  defer the offer until the next terminal command. Bulk progress stays local in
  `~/.showtail-cli/migrations/`, and missed repositories remain available to the
  project-local command.
- **Migration preserves the old trail.** Existing journal bytes are never
  rewritten during recovery. Provider timestamps reconstruct historical order,
  while append-only enrichment records disclose when recovery occurred and
  identify the source by provider session id and transcript digest—never by a
  committed absolute path.
- **Maintainers can test Showtail in an isolated Docker environment.** The image
  builds the current checkout with Claude Code and Codex, while the manual runner
  keeps agent state and scratch projects in private volumes. A non-quota preflight
  and an opt-in live regression exercise real prompt and artifact capture without
  exposing host settings or credentials to the build context.

### Fixed

- **Failed Claude shell commands retain their numeric exit code in structured
  exports.** When Claude records `Exit code N` only in the result text, Showtail
  now recovers the number while preserving the original content and error flag,
  so report consumers can replay the command deterministically.
- **Windows can install the Showtail extension through VS Code and Antigravity
  launchers.** Batch-based `code` and `antigravity-ide` commands now run through
  `cmd.exe`, covering both absolute `.cmd` paths and bare commands resolved by
  `PATHEXT` while leaving POSIX launches unchanged.

## 0.14.1

### Fixed

- **0.14.0 reported itself as `0.13.2`, and upgrading to it didn't refresh your
  capture hooks.** The version lives in two places that have to move together —
  `package.json` and `src/core/version.ts` (a compiled binary can't read
  `package.json`, so that constant is the only version it knows) — and only the
  first was bumped. Beyond `showtail --version` printing the wrong number, the
  auto-connect sweep re-wires a tool's hooks only when the running version differs
  from the one that last wrote them, so anyone upgrading to 0.14.0 silently kept
  their old wiring. Both now agree, and a test asserts they always will.

## 0.14.0 — Moving your project keeps its trail

### What changed
- **Moving or renaming a project no longer loses its work.** Showtail recorded
  where your files were, not what was in them, so moving a folder — or asking your
  AI tool to move it — quietly orphaned everything captured there. It now
  recognizes work by its **content**: a file that still matches, or a captured git
  commit present in the folder's history. `showtail track <new folder>` picks the
  work back up at its new home.
- **Moved work stays visible.** A session whose folder has vanished now shows in
  `showtail inbox` tagged **`[files moved or deleted]`**, instead of being filed
  away as scratch where you'd never look for it. (Trivial sessions are still kept
  aside, so the inbox doesn't fill up with noise.) `showtail inbox --json` gained a
  `pathGone` flag.
- **Nothing is attributed on a guess.** Only conclusive evidence places work
  automatically. A mere resemblance is listed for you to confirm with
  `showtail move <id> --to .` — filenames are never treated as evidence, because
  every student has a dozen `main.py` files.
- **`showtail track` is safe to re-run.** Re-running it in a folder that already
  has a `.showtail/` now still pulls in orphaned work — exactly the case you hit
  after moving a project that was already being tracked. `--json` reports
  `backfilled` and `candidates`.
- **`showtail status` and `showtail report` notice a move** and update the
  project's recorded location, so past sessions stop showing as missing without
  waiting for your next AI session. `status` also warns if a folder looks *copied*
  rather than moved, since two copies sharing one trail id will fight over it.
- **Edits whose content was never captured are no longer dropped.** They're
  recorded by name, and the command tells you the content is unrecoverable rather
  than silently omitting the change.

### Notes
- `showtail verify` no longer fails a trail merely because an edit has no recorded
  hash — a legitimate case for imported edits and deleted files.
- Nothing to run and no format change: this is all recognition, not new capture, so
  it works on sessions already sitting in your ledger.

## 0.13.2

### Fixed

- **`showtail report` prints the report's full path again.** 0.13.0's open menu
  shortened the printed line to the bare filename — `Wrote report (ada): report-ada-
  2026-08-02T175428.html` — which said the report existed but not where, so there was
  nothing to copy, hand to someone, or feed to another command, and terminals had no
  path to linkify. The line names the whole path once more, and stays a clickable
  hyperlink in terminals that render OSC 8 (Windows Terminal, VS Code, iTerm2, kitty,
  GNOME Terminal, WezTerm, Ghostty). The once/always/never open menu is unchanged.

## 0.13.1

### Fixed

- **A project that ignores `*.log` silently committed a trail with no prompts in it.**
  Journal segments are named `journal/<machine>/0001.log`, and the Node, Python and
  Java `.gitignore` templates all ship a `*.log` line — so git excluded every segment,
  the student handed in a trail containing their config and object store but none of
  their work, and nobody was told. The trail's own `.gitignore` now negates it
  (`!authors/**/journal/**/*.log`), and re-running `showtail track .` repairs a trail
  created before this fix. Showtail's own repository had the bug.
- **`verify` now names the rule when git is ignoring the journal**, instead of saying
  "not committed to git yet" and sending you after a `git add` that would do nothing.
  It distinguishes an accidental `*.log` (which `showtail track .` repairs) from a
  deliberate `.showtail/` exclusion (which only you can reverse), and reports
  `skipped: "journal-ignored"` in `--json`.

## 0.13.0

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
- **`showtail verify` now anchors the journal to git history — the check that catches
  a re-chained trail.** The hash chain can only prove the journal is *internally*
  consistent, and anything that can write `.showtail/` can produce a consistent
  journal: edit an entry, re-link everything after it, and the chain check passes. A
  journal segment is append-only, so the new check (`journal history is append-only
  (git)`) walks its whole history with `git log --numstat`: every commit should add
  lines and remove none, and a re-chain or a truncation shows up as removals. The
  working tree is checked too, so a rewrite is caught before it is committed. Each
  rewrite is reported with its commit SHA and date, and reconciled against the markers
  `showtail redact` and `showtail import undo` leave — only undeclared rewrites fail.
  The wording says history was rewritten, not that anyone cheated. **No git, not a
  repo, or a trail not committed** stays informational and never fails — but a
  **shallow clone** is reported as *not verified* rather than passed, since it has no
  history to read. `showtail import undo` now records a marker of its own, so a
  supported undo isn't mistaken for an undeclared rewrite.
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
