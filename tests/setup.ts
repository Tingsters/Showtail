import { afterEach } from 'bun:test';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-process root for every pinned temp home below.
 *
 * These pins used to be fixed names (`$TMPDIR/showtail-test-home`, …), which made
 * the suite un-runnable concurrently: two `bun test` runs — two worktrees, two
 * agents, or a parallel CI leg — shared one ledger and one set of tool homes, and
 * the `afterEach` sweeps below would delete state out from under the *other* run
 * mid-test. The result was a drifting handful of failures in whichever suite lost
 * the race (the plan-capture / capability-backing / inbox-surface tests, which all
 * touch machine-global state), reproducible only under load and easy to misread as
 * a pre-existing flake in the code under test.
 *
 * Keying on the pid makes each run's state private, so concurrent runs are honest.
 * An externally-set value still wins everywhere (the `??=` below), so CI can pin
 * its own paths.
 */
// `testrun`, deliberately NOT the `showtail-test-` prefix `makeTempDir()` uses for
// per-test dirs — these are a different kind of thing with a different lifetime,
// and keeping the namespaces apart is what lets the sweep below match on its own
// names only, instead of a broad wildcard over shared /tmp.
const RUN_ROOT_PREFIX = 'showtail-testrun-';
const RUN_ROOT = join(tmpdir(), `${RUN_ROOT_PREFIX}${process.pid}`);

/**
 * The two pid-owned shapes this sweep may delete, and nothing else:
 *   - `showtail-testrun-<pid>`          — a run root (above)
 *   - `showtail-test-<pid>-XXXXXX`      — a per-test dir from `makeTempDir()`
 *
 * They overlap textually — `showtail-test-` is a prefix of `showtail-testrun-` —
 * so each family spells out its *whole* shape here instead of a `startsWith()`,
 * which the looser prefix would let swallow the other. Both are anchored and
 * require the pid to be digits, which also excludes fixed names in the same
 * namespace that no pid owns and that this sweep must never touch
 * (`showtail-test-identity` from helpers.ts, `showtail-no-vscode-cli`, …), plus
 * anything that isn't ours at all.
 */
const SWEEPABLE_NAME = /^(?:showtail-testrun-(\d+)|showtail-test-(\d+)-.+)$/;

/**
 * Drop this run's private root, plus any root *or* per-test dir left behind by a
 * run that is no longer alive. The exit hook alone isn't enough — a suite killed
 * by a signal, or a timeout, never runs it, and in practice `process.on('exit')`
 * does not fire under `bun test` at all — so these would otherwise accumulate one
 * root and dozens of temp dirs per aborted run (they did: thousands of them).
 * Matching is on our own pid-stamped names and gated on the pid being *dead*, so
 * a concurrent run's dirs are never touched. Best-effort throughout.
 */
function sweepRunRoots(): void {
  const drop = (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  };
  drop(RUN_ROOT);
  try {
    for (const name of readdirSync(tmpdir())) {
      const match = SWEEPABLE_NAME.exec(name);
      const pid = Number(match?.[1] ?? match?.[2]);
      // NaN when the name isn't one of ours; `=== process.pid` leaves our own
      // in-flight temp dirs to the tests' explicit `cleanup()`.
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0); // Alive — another suite is using it. Leave it alone.
        continue;
      } catch {
        /* ESRCH: the owning process is gone, so its root is ours to remove. */
      }
      drop(join(tmpdir(), name));
    }
  } catch {
    /* ignore */
  }
}

sweepRunRoots();
process.on('exit', sweepRunRoots);

// Give in-process tests a deterministic student identity so `runInit` and the
// hooks can establish an author folder without prompting or shelling out to
// gh/git. `SHOWTAIL_IDENTITY_HOME` keeps the machine-identity cache inside the
// OS temp dir, never the developer's real `~/.config/showtail`.
process.env.SHOWTAIL_IDENTITY_EMAIL ??= 'tester@example.com';
process.env.SHOWTAIL_IDENTITY_NAME ??= 'Test Student';
process.env.SHOWTAIL_IDENTITY_HOME ??= join(RUN_ROOT, 'identity');

// Isolate the machine-global durable ledger (`SHOWTAIL_HOME`) for the whole test
// run, so hooks never write to the developer's real `~/.showtail-cli/ledger`.
// Spawned CLIs inherit it through `spawnEnv()`'s `...process.env`; tests that pin
// their own home via `envWithHome` override it per test.
process.env.SHOWTAIL_HOME ??= join(RUN_ROOT, 'home');

// Clear the shared machine-global state after each test. The per-project `.showtail/`
// is already isolated by its temp dir, but the ledger AND global config live under
// `SHOWTAIL_HOME`: tests reuse native session ids (e.g. `sess-1`) so ledger records
// would leak, and global config keys (`captureSince`, `autoInit`) written by one test
// (e.g. `setup`) would leak into the next and change surfacing/backfill behavior.
// Best-effort; never throws.
afterEach(() => {
  const home = process.env.SHOWTAIL_HOME ?? '';
  try {
    // maxRetries covers Windows, which releases file handles asynchronously and
    // so intermittently fails an immediate delete with EBUSY/EPERM (see cleanup()
    // in helpers.ts). Silently swallowing that here would leak ledger records into
    // the next test, which is exactly what this hook exists to prevent.
    rmSync(join(home, 'ledger'), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    rmSync(join(home, 'config.json'), { force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* ignore */
  }
});

// Cap `findRoot`'s upward walk at the OS temp dir for the entire test run. Test
// temp dirs are created under `tmpdir()` (see makeTempDir), which itself sits
// under the developer's home — so without this boundary an in-process `findRoot`
// on an uninitialized temp dir (e.g. requirePaths) would escape the sandbox and
// resolve the developer's real `~/.showtail`, both failing locally and polluting
// the live trail. Spawned CLIs get the same boundary via spawnEnv() in
// tests/helpers.ts. Honor an externally-set value (e.g. CI) if present.
process.env.SHOWTAIL_ROOT_CEILING ??= tmpdir();

// Isolate the Gemini/Antigravity config home (`~/.gemini`) for the whole test
// run. The Antigravity IDE and Gemini CLI plugins resolve hooks/instructions under
// `geminiHome()` (honors GEMINI_HOME). The Antigravity IDE writes its hooks to the
// GLOBAL `~/.gemini/config/hooks.json` for every scope — so without this, an
// in-process connect/uninstall test (plugins.test, capability-backing) would
// mutate the developer's REAL hooks.json: the uninstall step strips the live
// Showtail bundle, silently breaking the dev's own IDE capture. Pin it to a temp
// dir so tests never touch the real file. Spawned CLIs inherit it via spawnEnv();
// per-test overrides (antigravityIde.test) still win. Honor an external value.
process.env.GEMINI_HOME ??= join(RUN_ROOT, 'gemini');

// Isolate the Codex config home (`~/.codex`). Every user-scope Codex target —
// `hooks.json`, `config.toml`, `AGENTS.md` — resolves under `CODEX_HOME`, and the
// connect/disconnect tests write and DELETE those files: without this pin an
// in-process `codex install --user` (or the first-run bootstrap) would overwrite
// the developer's real `~/.codex/hooks.json` and `uninstall` would strip it,
// silently killing their own Codex capture. It also skews detection the other
// way: `codexAutoCaptureActive()` reads the user-scope hooks.json, so a dev with
// real Showtail hooks installed saw "capture active" where CI (no `~/.codex`)
// saw the opposite — the long-standing local-only failure in codex.test.ts.
// Spawned CLIs inherit it via spawnEnv(); per-test overrides still win.
const CODEX_HOME_DEFAULT = join(RUN_ROOT, 'codex');
process.env.CODEX_HOME ??= CODEX_HOME_DEFAULT;

// Isolate the Copilot CLI config home (`~/.copilot`). User-scope connect writes
// `~/.copilot/hooks/showtail.json` and an instructions file, and disconnect
// removes them — so without this pin a connect/uninstall test would clobber the
// developer's live Copilot CLI hooks. Also keeps session discovery
// (`~/.copilot/session-state`) off their real transcripts.
const COPILOT_HOME_DEFAULT = join(RUN_ROOT, 'copilot');
process.env.COPILOT_HOME ??= COPILOT_HOME_DEFAULT;

// Isolate the Claude Code config home (`~/.claude`). User-scope `connect claude`
// merges our hooks into `~/.claude/settings.json` and installs
// `~/.claude/skills/showtail/SKILL.md`; disconnect unmerges and deletes them. On
// the machine running these tests that settings.json is the developer's OWN
// Claude Code config, so an unpinned run would rewrite the settings file driving
// the very session under way. Also keeps transcript discovery
// (`~/.claude/projects`) off their real session logs.
const CLAUDE_CONFIG_DIR_DEFAULT = join(RUN_ROOT, 'claude');
process.env.CLAUDE_CONFIG_DIR ??= CLAUDE_CONFIG_DIR_DEFAULT;

// Sweep the pinned host-tool homes after each test, for the same reason the
// `SHOWTAIL_HOME` hook above exists: a user-scope `connect` writes real hooks /
// settings / skills into them, and a later test that asks "is auto-capture
// active?" would see the previous test's install and assert the opposite of what
// a clean machine reports. Until now that residue landed in the developer's REAL
// `~/.codex`, which is exactly why `codex.test.ts` failed locally and passed in
// CI. Only the pinned defaults are removed — never a path a test set itself, so
// per-test `CODEX_HOME` fixtures survive their own run. Best-effort; never throws.
afterEach(() => {
  for (const dir of [
    CODEX_HOME_DEFAULT,
    COPILOT_HOME_DEFAULT,
    CLAUDE_CONFIG_DIR_DEFAULT,
  ]) {
    try {
      // maxRetries for the same Windows reason as the hook above: a spawned CLI
      // may still be releasing handles, and an EBUSY here would leak a user-scope
      // install into the next test's detection.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
});

// Neutralize VS Code detection for the whole test run. The copilot plugin's
// `findVsCodeCli()` probes absolute app-bundle paths (e.g. /Applications/Visual Studio
// Code.app) that escape PATH/HOME isolation — so on a dev machine with VS Code installed
// it would make copilot "detected" in tests that assume an empty PATH means nothing is
// present, and could let an in-process `autoConnect` run a REAL `code --install-extension`.
// Point the override at a nonexistent path so `findVsCodeCli()` returns null unless a test
// opts in by setting `SHOWTAIL_VSCODE_CLI` to its own stub. Honor an external value.
process.env.SHOWTAIL_VSCODE_CLI ??= join(tmpdir(), 'showtail-no-vscode-cli');

// Same hazard, Antigravity IDE: `findAntigravityIdeCli()` probes absolute app-bundle
// paths (/Applications/Antigravity.app, ~/.local/bin/antigravity-ide) that no HOME or
// PATH isolation reaches, and `installAntigravityIdeExtension()` then SPAWNS it — so on
// a dev machine with the IDE installed a connect/auto-connect test could really install
// (or downgrade) the extension in their editor. Point it at a nonexistent path so the
// lookup returns null unless a test supplies its own stub. Honor an external value.
process.env.SHOWTAIL_ANTIGRAVITY_CLI ??= join(tmpdir(), 'showtail-no-antigravity-cli');

// Isolate VS Code's `workspaceStorage`, where Copilot Chat keeps its session files.
// `copilotWorkspaceStorageDirs()` otherwise walks the real per-platform locations
// (~/Library/Application Support/Code/User/workspaceStorage on macOS), so a Copilot
// import/detection test on a dev machine would read — and could import into a trail —
// the developer's actual Copilot Chat history. Read-only today, but it makes results
// depend on whoever's laptop is running the suite. Point it at a nonexistent dir so
// discovery finds nothing unless a test opts in. Honor an external value.
process.env.SHOWTAIL_VSCODE_STORAGE ??= join(tmpdir(), 'showtail-no-vscode-storage');
