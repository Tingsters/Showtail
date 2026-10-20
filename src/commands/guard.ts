import {
  GUARD_REFUSED,
  installGuardHooks,
  pushedPaths,
  stagedPaths,
  trailViolations,
  uninstallGuardHooks,
  violationMessage,
} from '../core/guard.ts';
import { ShowtailError } from '../core/errors.ts';
import { gitToplevel } from '../core/git.ts';
import { findRoot, pathsForRoot, readConfig } from '../core/storage.ts';
import { SUBMISSION_DIR, verifySubmission } from '../core/submission.ts';
import { join } from 'node:path';

export interface GuardCheckOptions {
  staged?: boolean;
  push?: boolean;
  cwd?: string;
}

/** Read all of stdin (the `pre-push` hook feeds ref lines to it). */
async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
}

/** True when this repo's trail has opted into being committed. */
function trailMayBeCommitted(cwd: string): boolean {
  const root = findRoot(cwd);
  if (!root) return false;
  try {
    return readConfig(pathsForRoot(root)).settings.commitTrail === true;
  } catch {
    return false;
  }
}

/**
 * The hook entry point: refuse (exit 1) when the commit or push would carry the
 * private working trail. Fails closed: if git cannot say what a push contains, the
 * push is refused rather than waved through (`git push --no-verify` is the escape).
 */
export async function runGuardCheck(options: GuardCheckOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (trailMayBeCommitted(cwd)) return;
  const verb = options.push ? 'push' : 'commit';
  let paths: string[];
  try {
    paths = options.push
      ? await pushedPaths(cwd, await readStdin())
      : await stagedPaths(cwd);
  } catch (err) {
    throw new ShowtailError(
      `Showtail: could not check what this ${verb} contains (${(err as Error).message.split('\n')[0]}). ` +
        `Refusing to be safe; re-run with --no-verify if you are sure.`,
      GUARD_REFUSED,
    );
  }
  // A submission being committed must still verify: unedited since it was signed
  // and still clean under a fresh scan. (The working trail is refused outright below.)
  if (paths.some((p) => p.split(/[\\/]/).includes(SUBMISSION_DIR))) {
    const top = (await gitToplevel(cwd)) ?? cwd;
    const check = verifySubmission(join(top, SUBMISSION_DIR));
    if (!check.ok) {
      throw new ShowtailError(
        `Showtail: refusing to ${verb} ${SUBMISSION_DIR}/: ${check.problems.join('; ')}. ` +
          'Run `showtail submit` to regenerate it.',
        GUARD_REFUSED,
      );
    }
  }
  const violations = trailViolations(paths);
  if (violations.length > 0)
    throw new ShowtailError(violationMessage(violations, verb), GUARD_REFUSED);
}

export async function runGuardInstall(cwd = process.cwd()): Promise<void> {
  const root = (await gitToplevel(cwd)) ?? cwd;
  const written = await installGuardHooks(root);
  console.log(
    written.length > 0
      ? `Installed the Showtail guard in: ${written.join(', ')}.`
      : 'The Showtail guard is already installed (or this is not a git repository).',
  );
}

export async function runGuardUninstall(cwd = process.cwd()): Promise<void> {
  const root = (await gitToplevel(cwd)) ?? cwd;
  const removed = await uninstallGuardHooks(root);
  console.log(
    removed.length > 0
      ? `Removed the Showtail guard from: ${removed.join(', ')}.`
      : 'No Showtail guard found in this repository.',
  );
}
