# Working in this repo (Claude-driven, PR-based)

GitHub (`origin` → https://github.com/Tingsters/Showtail.git) is the source of
truth. `main` changes only by merging pull requests there. Nobody hand-edits
code: every change is made by an agent on its own branch, in its own worktree.

The old bare-hub workflow (`~/Nextcloud/Showtail.git`, landing with
`update-ref` straight onto `main`) is retired. Its `main` stopped tracking
GitHub in September 2026. Don't land through it, and don't treat the Nextcloud
copies as current.

## Rules

**1. Start from GitHub's `main`, in a worktree.**

    git fetch origin
    git worktree add -b <type>/<topic> ../Showtail-<topic> origin/main

Never work in, or commit from, a checkout that sits on `main`. A local `main`
can lag `origin/main`, so always branch from `origin/main`.

**2. Verify before opening a PR.**

    bun install --frozen-lockfile
    bun run typecheck
    bun test                        # zero failures

If a dependency changes, commit `bun.lock` with `package.json`. CI installs with
`--frozen-lockfile` and fails when the two disagree.

**3. Push the branch and open a PR against `main`.** Never push to `main`
directly. CI runs `test` on Windows, macOS and Ubuntu, plus CodeQL and the
report audits.

**4. Merge once every check is green.** Use a merge commit
(`gh pr merge <n> --merge`). If `main` moved and the PR conflicts, rebase the
branch onto `origin/main`, resolve the conflicts yourself, and push again
(`--force-with-lease` on your own branch only).

**5. Dependabot PRs.** If one fails only because its base is stale, comment
`@dependabot rebase`. Close any that bump a major version the ignore rules in
`.github/dependabot.yml` hold back. CodeQL `init` and `analyze` must stay on
the same version.

**Never**: `git push --force` to `main`, `git checkout main` in a working
checkout, or commit unrelated files from a dirty tree.
