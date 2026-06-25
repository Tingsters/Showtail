# Changelog

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
