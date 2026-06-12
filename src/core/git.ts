import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git helpers. Every function here degrades gracefully: if git is not
 * installed, or the project is not a git repo, callers get `undefined`/`false`
 * instead of an error. Showtail must work fine without git.
 */

async function runGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Return true if `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return out === 'true';
}

/**
 * Return the current commit hash, or `undefined` if unavailable
 * (no git, not a repo, or a repo with no commits yet).
 */
export async function currentCommit(cwd: string): Promise<string | undefined> {
  return runGit(['rev-parse', 'HEAD'], cwd);
}

/**
 * Convenience: only resolve a commit hash when `enabled` is true.
 * Used so config can turn git capture off entirely.
 */
export async function maybeCurrentCommit(
  cwd: string,
  enabled: boolean,
): Promise<string | undefined> {
  if (!enabled) return undefined;
  return currentCommit(cwd);
}
