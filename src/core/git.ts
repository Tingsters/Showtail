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

/** Run an arbitrary command, returning trimmed stdout or undefined on any failure. */
async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd });
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

/**
 * The student's configured git identity (`user.email` / `user.name`), or
 * `undefined` fields when git isn't available. This is the same identity that
 * stamps their commits, so attribution lines up with what GitHub already shows.
 */
export async function gitUser(cwd: string): Promise<{ email?: string; name?: string }> {
  const [email, name] = await Promise.all([
    runGit(['config', 'user.email'], cwd),
    runGit(['config', 'user.name'], cwd),
  ]);
  return { email: email || undefined, name: name || undefined };
}

/** A GitHub identity, as returned by `gh api user`. */
export interface GhUser {
  login?: string;
  name?: string;
  email?: string;
}

/**
 * The authenticated GitHub user via the `gh` CLI, or `undefined` if `gh` is
 * absent / not logged in. `email` may be null on GitHub when the user keeps it
 * private; callers fall back to git in that case.
 */
export async function ghApiUser(cwd: string): Promise<GhUser | undefined> {
  const out = await runCmd('gh', ['api', 'user'], cwd);
  if (!out) return undefined;
  try {
    const json = JSON.parse(out) as Record<string, unknown>;
    return {
      login: typeof json.login === 'string' ? json.login : undefined,
      name: typeof json.name === 'string' ? json.name : undefined,
      email: typeof json.email === 'string' ? json.email : undefined,
    };
  } catch {
    return undefined;
  }
}
