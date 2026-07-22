# Working in this repo (Claude-driven, trunk-based)

This repo is served by a **bare hub** at `~/Nextcloud/Showtail.git`. `main` lives
only in the hub and is **never checked out anywhere**, so it can never be frozen —
the "phantom diff" failure mode is *structurally* impossible, not just discouraged.
The hub mirrors to GitHub (`origin`).

Nobody hand-edits code: every change is made by an agent, in a worktree, and lands
straight on `main` — **there are no pull requests**. You are always in either a
per-task worktree (Claude Code creates one automatically) or the **desk** worktree
(the interactive launch pad, permanently on the throwaway `desk` branch).

## Rules

**1 — Never check out `main`.** Work on your task branch (your worktree's branch)
or `desk`. Inspect the trunk without checking it out: `git log main`,
`git show main:<path>`.

**2 — Land straight to `main` when your work is done and tests pass. No PR.**

    git rebase main                 # replay your work onto the current trunk
    bun test                        # must pass — see "known failure" below
    base=$(git rev-parse main)
    git update-ref refs/heads/main "$(git rev-parse HEAD)" "$base"   # advance trunk
    git push origin main            # mirror to GitHub
    git -C ~/Nextcloud/Showtail merge --ff-only main 2>/dev/null || true   # keep the desk's files current

The last line fast-forwards the **desk** so its checkout never holds stale files
(a stale checkout is the tripwire this whole workflow exists to avoid). It's a
no-op if the desk is absent/busy.

If `update-ref` fails, `main` moved under you (another agent landed first) —
re-run `git rebase main` and retry. `update-ref` is safe here (unlike an ordinary
repo, where it's a footgun) **precisely because `main` is never checked out**: the
bare hub owns it and no worktree sits on it, so advancing it can't freeze anyone's
files.

**3 — Resolve your own conflicts.** If the rebase conflicts, fix it in your
worktree and finish the land — never leave a half-integrated branch or a conflict
for a human. Keep tasks scoped so parallel agents rarely touch the same files.

**Never**: open a PR, `git push --force`, `git checkout main`, or edit the bare hub
directly.

## Known test failure (pre-existing, ignore)
`codex install / uninstall > install --no-hooks writes only AGENTS.md, no
hooks/config` fails independently of your change (it fails on a pristine `main`).
Don't let it block a land; don't "fix" it as part of an unrelated task.

## Layout
- **Hub** (bare, source of truth): `~/Nextcloud/Showtail.git` — holds `main` + the
  object store. Never checked out. Mirrors to `origin` (GitHub).
- **Desk** (interactive launch pad): `~/Nextcloud/Showtail`, branch `desk`. Where a
  human opens a terminal and starts Claude. Never on `main`, but kept continuously
  fast-forwarded to it, so it never shows stale files: the land step above ff's it
  after every land, and a `SessionStart` hook (in the desk's `.claude/settings.local.json`)
  ff's it to GitHub's `main` each time Claude launches there.
- **Task worktrees**: `.../.claude/worktrees/<task>` — Claude Code-managed, one per
  task, auto-removed when done.
- **GitHub mirror**: `origin` → https://github.com/Tingsters/Showtail.git.

## Why it's built this way
A single long-running agent used to publish to a local `main` via `update-ref`
while a checkout sat *on* `main` and was never resynced — so `main` advanced under
frozen files and produced a large phantom reverse-diff. The bare hub removes the
precondition entirely: with `main` un-checkout-able, the same `update-ref` publish
is safe, parallel agents land without merge ceremony, and there is nothing for a
human to babysit.
