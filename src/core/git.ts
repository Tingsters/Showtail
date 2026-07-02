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
 * The absolute path of the git working-tree root containing `cwd`, or
 * `undefined` if `cwd` is not inside a repo (or git is unavailable). Used to
 * anchor a project's `.showtail/` at the repo root so one repo gets one trail.
 * Git prints forward slashes even on Windows; callers `resolve()` the result so
 * it compares equal to `findRoot`'s output.
 */
export async function gitToplevel(cwd: string): Promise<string | undefined> {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Repo-root-relative paths (posix separators) of files currently added or
 * modified in the working tree at `cwd` — staged or unstaged — excluding
 * deletions and rename-aways. Empty when git is unavailable, `cwd` isn't a repo,
 * or nothing changed.
 *
 * Used as a backstop to recover edits a tool made via raw shell (e.g. a path
 * held in a shell variable) that structured payload parsing couldn't see.
 * Returned relative (not absolute) so the caller resolves them against the trail
 * root with one consistent spelling — avoiding short-path/case mismatches
 * between git's output and the trail root.
 */
export async function changedFiles(cwd: string): Promise<string[]> {
  if (!(await isGitRepo(cwd))) return [];
  // `-z`: NUL-terminated records, no path quoting/escaping to undo. Paths are
  // relative to the repo root regardless of `cwd` being a subdir.
  const out = await runGit(['status', '--porcelain', '--no-renames', '-z'], cwd);
  if (!out) return [];
  const files: string[] = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue; // need 2-char status + space + path
    if (rec.slice(0, 2).includes('D')) continue; // deletion — nothing to snapshot
    const path = rec.slice(3);
    if (path) files.push(path.replace(/\\/g, '/'));
  }
  return files;
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
