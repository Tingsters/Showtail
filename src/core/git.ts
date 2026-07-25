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
 * `cwd`'s path relative to its repository root, in git's own spelling (posix
 * separators, no trailing slash; `''` when `cwd` *is* the root). `undefined` when
 * `cwd` is not in a repo or git is unavailable.
 *
 * Prefer this over deriving the same string from two absolute paths. Comparing
 * Node's spelling of a path against git's is a losing game on Windows: git
 * reports the long form of a directory (`C:\Users\runneradmin\…`) while `TEMP`
 * on a GitHub runner hands out the 8.3 short form (`C:\Users\RUNNER~1\…`), and
 * `realpathSync` does *not* expand short names, so both sides can resolve
 * "successfully" and still disagree. `relative()` then climbs out with `..` and
 * the caller concludes the directory sits outside its own repository. Asking git
 * removes the comparison altogether.
 */
export async function gitPrefix(cwd: string): Promise<string | undefined> {
  const out = await runGit(['rev-parse', '--show-prefix'], cwd);
  if (out === undefined) return undefined;
  return out.replace(/\/+$/, '');
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
 * Line counts for one diff, restricted to the paths a caller cares about.
 * `binary` is set when git reported `-` instead of numbers for a path (a file
 * marked binary): the counts are then *unknowable*, and a caller must not read
 * `deleted: 0` as "nothing was removed".
 */
export interface Numstat {
  /** Lines added. */
  added: number;
  /** Lines deleted. */
  deleted: number;
  /** Repo-relative paths (posix separators) the diff touched. */
  paths: string[];
  /** At least one touched path was binary, so its counts are unknown. */
  binary?: boolean;
}

/** One revision of a path in git history (see {@link fileHistoryNumstat}). */
export interface FileRevision extends Numstat {
  /** Full commit SHA. */
  commit: string;
  /** Committer date, ISO-8601 with the committer's offset (git's `%cI`). */
  date: string;
}

/** Regex-free split of one `--numstat` line: `<added>\t<deleted>\t<path>`. */
function addNumstatLine(into: Numstat, line: string): void {
  const first = line.indexOf('\t');
  const second = line.indexOf('\t', first + 1);
  if (first < 0 || second < 0) return;
  const added = line.slice(0, first);
  const deleted = line.slice(first + 1, second);
  const path = line.slice(second + 1);
  if (!path) return;
  into.paths.push(path);
  // git prints "-" for a binary path. Counting it as 0 would silently claim
  // nothing was removed, so flag it and let the caller refuse to conclude.
  if (added === '-' || deleted === '-') {
    into.binary = true;
    return;
  }
  into.added += Number(added) || 0;
  into.deleted += Number(deleted) || 0;
}

/**
 * Every commit that touched `relPath` (a file or a directory), oldest first,
 * with the lines it added and removed there. Empty when git is unavailable,
 * `repoRoot` isn't a repo, or the path has no history — the usual graceful
 * degradation, so a caller can never tell "clean" from "unknown" by this alone.
 *
 * `include` filters which touched paths count, which is what lets a caller pass
 * a whole directory (so files *deleted* from it are still seen — querying only
 * the files that exist today would miss exactly that) while counting only the
 * files it cares about. Commits left with no matching path are omitted.
 *
 * `--no-renames` on purpose: with rename detection on, moving a file away reads
 * as a rename with no line changes, which would hide a removal.
 */
export async function fileHistoryNumstat(
  repoRoot: string,
  relPath: string,
  include?: (path: string) => boolean,
): Promise<FileRevision[]> {
  // \x01 opens each commit record so the format line is unambiguous even if a
  // path ever contained a newline; %cI is ISO-8601 with the committer's offset.
  const out = await runGit(
    [
      '-c',
      'core.quotePath=false',
      'log',
      '--no-renames',
      '--numstat',
      '--format=%x01%H%x09%cI',
      '--',
      relPath,
    ],
    repoRoot,
  );
  if (!out) return [];
  const revisions: FileRevision[] = [];
  for (const record of out.split('\x01')) {
    if (record.trim() === '') continue;
    const lines = record.split('\n');
    const tab = lines[0]!.indexOf('\t');
    const commit = tab < 0 ? lines[0]! : lines[0]!.slice(0, tab);
    if (commit === '') continue;
    const rev: FileRevision = {
      commit,
      date: tab < 0 ? '' : lines[0]!.slice(tab + 1),
      added: 0,
      deleted: 0,
      paths: [],
    };
    for (const line of lines.slice(1)) {
      if (line === '') continue;
      if (include) {
        const path = line.slice(line.indexOf('\t', line.indexOf('\t') + 1) + 1);
        if (!include(path)) continue;
      }
      addNumstatLine(rev, line);
    }
    if (rev.paths.length > 0) revisions.push(rev);
  }
  // git log prints newest first; history reads oldest first.
  return revisions.reverse();
}

/**
 * What the working tree (staged and unstaged) changes under `relPath` relative
 * to `HEAD` — the same shape as one {@link fileHistoryNumstat} revision, for a
 * rewrite that has not been committed yet. Zeroed when git is unavailable, the
 * dir isn't a repo, or the repo has no commits.
 */
export async function uncommittedNumstat(
  repoRoot: string,
  relPath: string,
  include?: (path: string) => boolean,
): Promise<Numstat> {
  const stat: Numstat = { added: 0, deleted: 0, paths: [] };
  const out = await runGit(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-renames',
      '--numstat',
      'HEAD',
      '--',
      relPath,
    ],
    repoRoot,
  );
  if (!out) return stat;
  for (const line of out.split('\n')) {
    if (line === '') continue;
    if (include) {
      const path = line.slice(line.indexOf('\t', line.indexOf('\t') + 1) + 1);
      if (!include(path)) continue;
    }
    addNumstatLine(stat, line);
  }
  return stat;
}

/**
 * True when `cwd` is a shallow clone (`git clone --depth`, or GitHub Actions'
 * default `fetch-depth: 1` checkout). Only most-recent history is present, so
 * anything that reasons about a file's past has to say it cannot. False when
 * git is unavailable or `cwd` isn't a repo — same degradation as everywhere
 * here; callers establish "this is a repo" separately.
 */
export async function isShallowClone(cwd: string): Promise<boolean> {
  return (await runGit(['rev-parse', '--is-shallow-repository'], cwd)) === 'true';
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
