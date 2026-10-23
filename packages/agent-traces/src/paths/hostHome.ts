/**
 * Resolve where a *host tool* keeps its config, honoring that tool's own home
 * override.
 *
 * Every tool Showtail connects to (Claude Code, Codex, Copilot CLI, Antigravity)
 * stores its hooks/instructions in a fixed directory under HOME — `~/.claude`,
 * `~/.codex`, `~/.copilot`, `~/.gemini` — and every one of them lets you move
 * that directory with an environment variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `COPILOT_HOME`, `GEMINI_HOME`). Resolving with a bare `homedir()` ignores the
 * override, which is wrong twice over: it misses a relocated real install, and —
 * the reason this module exists — it makes the test suite read and *write* the
 * developer's live tool config. A connect/uninstall test that resolved `~/.codex`
 * for real would strip the developer's own `hooks.json` and silently break their
 * capture; a detection test would see their hooks and assert the opposite of what
 * an empty machine reports (which is why CI, with no `~/.codex`, disagreed with
 * every dev machine).
 *
 * The override names the **config directory itself**, not a fake HOME. Pointing
 * `CODEX_HOME` at `/tmp/x` means the config lives in `/tmp/x`, not `/tmp/x/.codex`
 * — this matches what the tools themselves do, and it means a test can hand out a
 * bare `mkdtemp` path without having to mint a dot-dir inside it.
 *
 * Only *user*-scope resolution goes through here. Project scope is anchored to the
 * repo root (`findRoot`), which is already sandboxed by `SHOWTAIL_ROOT_CEILING`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The config home for a host tool: `$envVar` if set and non-empty, else
 * `~/<dirName>`.
 *
 * @param envVar  The tool's own home variable, e.g. `'CODEX_HOME'`.
 * @param dirName The default directory name under HOME, e.g. `'.codex'`.
 */
export function hostHome(envVar: string, dirName: string): string {
  const override = process.env[envVar];
  return override && override.length > 0 ? override : join(homedir(), dirName);
}
