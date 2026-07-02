# Working in this repo (parallel agents)

`main` is a shared pointer, never a workspace. Parallel agents work in separate
git worktrees and publish to one local `main` with `git update-ref` (compare-and-
swap, so concurrent agents don't clobber each other). `update-ref` moves the
branch *pointer* only — it does **not** update the files of any worktree that has
`main` checked out. Work on `main` and another agent's publish freezes your files
while HEAD jumps ahead; `git status` then shows a "phantom" reverse diff of code
that's already committed. (Git refuses `git push` to a checked-out branch for this
very reason — `update-ref` is the bypass, safe only because nobody sits on `main`.)

Three rules keep this airtight:

**1 — Never check out `main`; work on your own branch.** Every worktree, including
the repo root, stays on a task branch. First thing:

    git branch --show-current     # prints "main"? get off it:
    git switch -c <task-branch>    # (refused due to a phantom diff? do rule 3 first)

Inspect main without checking it out: `git log main`, `git show main:<path>`.

**2 — Publish by CAS-advancing the pointer; never force it.** To land your branch:

    base=$(git rev-parse main)
    git rebase "$base"            # replay your work onto current main
    # run the relevant tests
    git update-ref refs/heads/main "$(git rev-parse HEAD)" "$base"

If `update-ref` fails, `main` moved under you — re-read `base`, rebase, retry.
Never `git branch -f main`, `git reset` main, or `git push --force`.

**3 — A phantom diff is not your work; never commit it.** If a worktree's status
shows a reverse diff of code already in `git log main` (files you know exist shown
as "deleted"), its pointer just moved. Resync, don't commit:

    git reset --hard main         # leaves untracked files (e.g. .claude/) alone

Publishing to GitHub, when wanted: `git push origin main` (works from any branch).
