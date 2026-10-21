/**
 * The git guard: a backstop that keeps Showtail's private working trail out of
 * commits and pushes.
 *
 * The primary protection is that `.showtail/` ignores itself (see `init.ts`), so a
 * plain `git add .` never stages it. This guard covers the paths that rule cannot:
 * `git add -f`, a trail that was already tracked before it became private, and a
 * push that carries an old commit containing the trail. It runs from a git
 * `pre-commit` and `pre-push` hook that Showtail installs into the repo.
 *
 * What it guards is *the working trail*, not the sanitised report: that is what
 * `showtail submit` produces, and it is meant to be shared.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GUARD_BEGIN = '# >>> showtail guard >>>';
export const GUARD_END = '# <<< showtail guard <<<';

const TRAIL_PATH = /(?:^|\/)\.showtail\/(.+)$/;
/** Inside `.showtail/` only the ignore file itself may ever be committed. */
const TRAIL_ALLOWED = new Set(['.gitignore']);

/** The staged/pushed paths that belong to the private working trail. */
export function trailViolations(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    const m = TRAIL_PATH.exec(p);
    if (m && !TRAIL_ALLOWED.has(m[1]!)) out.push(p);
  }
  return out;
}

/** The message a refused commit or push prints. */
export function violationMessage(violations: string[], verb: 'commit' | 'push'): string {
  const shown = violations.slice(0, 5).join('\n    ');
  const more = violations.length > 5 ? `\n    … and ${violations.length - 5} more` : '';
  return [
    `Showtail: refusing to ${verb} the working trail (${violations.length} file${violations.length === 1 ? '' : 's'} under .showtail/).`,
    `    ${shown}${more}`,
    '',
    "It holds your raw prompts, the AI's replies and code diffs, and secrets can end up",
    'in any of them. To share your work, run `showtail submit`: it writes a sanitised',
    'report that is safe to hand in or attach to a pull request.',
    '',
    'If .showtail/ was committed earlier, stop tracking it with:',
    '    git rm -r --cached .showtail',
    '(Educators who want the trail itself in git can set settings.commitTrail in',
    '.showtail/config.json.)',
  ].join('\n');
}

async function git(args: string[], cwd: string): Promise<string> {
  // Same hardening as core/git.ts: a repo's own config must not be able to run a program.
  const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Paths staged for the next commit (added, copied, modified, renamed). */
export async function stagedPaths(cwd: string): Promise<string[]> {
  const out = await git(
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    cwd,
  );
  return out.split('\0').filter(Boolean);
}

const ZERO_SHA = /^0+$/;

/**
 * Paths changed by the commits a `git push` is about to send. `lines` is the
 * `pre-push` hook's stdin (`<local ref> <local sha> <remote ref> <remote sha>`).
 * Throws if git cannot compute a range, so the caller fails closed.
 */
export async function pushedPaths(cwd: string, lines: string[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // a branch deletion
    const range =
      !remoteSha || ZERO_SHA.test(remoteSha)
        ? [localSha, '--not', '--remotes']
        : [`${remoteSha}..${localSha}`];
    const out = await git(
      ['log', '--name-only', '--pretty=format:', '-z', '--diff-filter=ACMR', ...range],
      cwd,
    );
    for (const p of out.split('\0')) if (p.trim()) paths.add(p.trim());
  }
  return [...paths];
}

/** Exit status `guard check` uses when it refuses; the hooks block only on this. */
export const GUARD_REFUSED = 5;

/**
 * The hook body. It blocks ONLY on the guard's own refusal. A missing `showtail`,
 * or an older one with no `guard` command (it exits 1 with "unknown command"),
 * must never stop a student from committing, so every other status is ignored.
 */
function hookBlock(what: string, flag: string): string {
  return [
    GUARD_BEGIN,
    `# Keeps Showtail's private working trail out of ${what}. Remove: showtail guard uninstall`,
    'if command -v showtail >/dev/null 2>&1; then',
    `  showtail guard check ${flag}`,
    '  showtail_rc=$?',
    // An explicit `if`: `[ … ] && exit 1` would leave status 1 behind when the
    // test is false, and that becomes the hook's own exit status (commit blocked).
    `  if [ "$showtail_rc" -eq ${GUARD_REFUSED} ]; then exit 1; fi`,
    'fi',
    GUARD_END,
  ].join('\n');
}

const BLOCKS: Record<'pre-commit' | 'pre-push', string> = {
  'pre-commit': hookBlock('commits', '--staged'),
  'pre-push': hookBlock('pushes', '--push'),
};

async function hooksDir(root: string): Promise<string | undefined> {
  try {
    const out = (await git(['rev-parse', '--git-path', 'hooks'], root)).trim();
    return out ? resolve(root, out) : undefined;
  } catch {
    return undefined; // not a git repo, or git is unavailable
  }
}

/** The text of `existing` with the guard block added or refreshed. */
export function withGuardBlock(
  existing: string | undefined,
  hook: keyof typeof BLOCKS,
): string {
  const block = BLOCKS[hook];
  if (existing === undefined || existing.trim() === '') return `#!/bin/sh\n${block}\n`;
  const start = existing.indexOf(GUARD_BEGIN);
  const end = existing.indexOf(GUARD_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + GUARD_END.length);
  }
  const sep = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}\n${block}\n`;
}

/** The text of `existing` without the guard block, or null if there is none. */
export function withoutGuardBlock(existing: string): string | null {
  const start = existing.indexOf(GUARD_BEGIN);
  const end = existing.indexOf(GUARD_END);
  if (start === -1 || end < start) return null;
  const rest = existing.slice(0, start) + existing.slice(end + GUARD_END.length);
  return rest.replace(/\n{3,}/g, '\n\n');
}

/**
 * Install (or refresh) the guard in the repo's `pre-commit` and `pre-push` hooks,
 * preserving whatever the student already has there. Returns the hooks written.
 * A no-op outside a git repo. Best-effort by design: a repo whose hooks directory
 * is read-only must not break capture.
 */
export async function installGuardHooks(root: string): Promise<string[]> {
  const dir = await hooksDir(root);
  if (!dir) return [];
  const written: string[] = [];
  for (const hook of ['pre-commit', 'pre-push'] as const) {
    const file = resolve(dir, hook);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      const next = withGuardBlock(existing, hook);
      if (next === existing) continue;
      writeFileSync(file, next, 'utf8');
      try {
        chmodSync(file, 0o755);
      } catch {
        // No POSIX modes here (Windows); git runs hooks through its own sh.
      }
      written.push(hook);
    } catch {
      // Unwritable hooks dir: skip. The self-ignoring .gitignore is the primary guard.
    }
  }
  return written;
}

/** Remove the guard block from the repo's hooks. Returns the hooks it was removed from. */
export async function uninstallGuardHooks(root: string): Promise<string[]> {
  const dir = await hooksDir(root);
  if (!dir) return [];
  const removed: string[] = [];
  for (const hook of ['pre-commit', 'pre-push'] as const) {
    const file = resolve(dir, hook);
    if (!existsSync(file)) continue;
    const next = withoutGuardBlock(readFileSync(file, 'utf8'));
    if (next === null) continue;
    writeFileSync(file, next.trim() === '#!/bin/sh' ? '' : next, 'utf8');
    removed.push(hook);
  }
  return removed;
}
