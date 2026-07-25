import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAuthorPaths, ensureAuthor } from '../src/core/authors.ts';
import { ensureMachineId, slugifyEmail } from '../src/core/identity.ts';
import {
  authorPaths,
  type AuthorPaths,
  type ShowtailPaths,
} from '../src/core/storage.ts';

/** The deterministic test identity seeded in tests/setup.ts. */
export const TEST_EMAIL = 'tester@example.com';
export const TEST_SLUG = 'tester-at-example-com';

/** Path to the CLI entry, for spawning the real binary from a test. */
export const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn the real CLI in `cwd` and return its captured output. `input` is piped
 * to stdin; `env` defaults to {@link spawnEnv}. This is the single spawner the
 * end-to-end test files share (each keeps a thin local `run` wrapper).
 */
export function runCli(
  cwd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    env: opts.env ?? spawnEnv(),
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

/** Read the structured JSON report `showtail report --format json` wrote into `dir`. */
export function readJsonReport(dir: string): any {
  const reportsDir = join(dir, '.showtail', 'reports');
  const file = readdirSync(reportsDir).find((f) => f.endsWith('.json'));
  if (!file) throw new Error(`No JSON report found in ${reportsDir}`);
  return JSON.parse(readFileSync(join(reportsDir, file), 'utf8'));
}

/** A spawn env with an isolated global home, so the auto-init opt-in is per-test. */
export function envWithHome(home: string): NodeJS.ProcessEnv {
  return { ...spawnEnv(), SHOWTAIL_HOME: home };
}

/**
 * Turn the global auto-init opt-in on by writing the global config directly.
 * Pass `setupCompletedAt` for tests that assert the stamp is present.
 */
export function enableAutoInit(home: string, setupCompletedAt?: string): void {
  mkdirSync(home, { recursive: true });
  const config: Record<string, unknown> = { version: 1, autoInit: true };
  if (setupCompletedAt) config.setupCompletedAt = setupCompletedAt;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config) + '\n', 'utf8');
}

/** Create a throwaway temp directory and return its path. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'showtail-test-'));
}

/**
 * The active author's paths for an initialized test project. `runInit` (run with
 * the identity env from setup.ts) establishes the author; this resolves it.
 */
export function authorFor(paths: ShowtailPaths): AuthorPaths {
  const author = activeAuthorPaths(paths);
  if (!author) {
    throw new Error(
      'No active author. Call runInit({cwd}) first (setup.ts seeds the identity env).',
    );
  }
  return author;
}

/**
 * Create an author folder directly (no init) for a given email — used by tests
 * that exercise multi-author behavior without spinning up two machines.
 */
export function seedAuthor(paths: ShowtailPaths, email: string): AuthorPaths {
  const machineId = ensureMachineId();
  ensureAuthor(paths, { email, name: email }, machineId);
  return authorPaths(paths, slugifyEmail(email), machineId);
}

/**
 * Remove a temp directory created with {@link makeTempDir}.
 *
 * `maxRetries` is for Windows: two dozen test files spawn the real CLI and then
 * delete its cwd. `spawnSync` has reaped the child by then, but Windows releases
 * file handles asynchronously and the indexer/AV can hold one a moment longer, so
 * an immediate delete intermittently fails with EBUSY/EPERM. Node retries those
 * two errnos with a backoff when `maxRetries` is set (it is 0 by default, so
 * `force` alone does not help). A no-op on POSIX, where the first attempt wins.
 */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Environment for spawning the real CLI from a test. Caps `findRoot`'s upward
 * walk at the OS temp dir so a test in a non-initialized temp dir can never
 * escape its sandbox and resolve a real `~/.showtail` (temp dirs live under the
 * user's home). Every test temp dir is created under `tmpdir()` by
 * {@link makeTempDir}, so this boundary is safe for both root- and subdir-cwd
 * runs while keeping the developer's live trail untouched.
 */
export function spawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHOWTAIL_ROOT_CEILING: tmpdir(),
    // Keep CLI-spawned tests hermetic: the first-run bootstrap pre-wires every tool at
    // user scope (real `~/.claude`, `~/.codex`, …), so leaving it on would let any test
    // that runs a command pollute the shared home. Tests that exercise the bootstrap
    // itself opt back in by deleting this key from their env.
    SHOWTAIL_DISABLE_FIRST_RUN: '1',
    // Deterministic identity so a spawned `showtail init` never prompts or shells
    // out to gh/git, and caches its machine identity inside the temp dir.
    SHOWTAIL_IDENTITY_EMAIL: process.env.SHOWTAIL_IDENTITY_EMAIL ?? TEST_EMAIL,
    SHOWTAIL_IDENTITY_NAME: process.env.SHOWTAIL_IDENTITY_NAME ?? 'Test Student',
    SHOWTAIL_IDENTITY_HOME:
      process.env.SHOWTAIL_IDENTITY_HOME ?? join(tmpdir(), 'showtail-test-identity'),
  };
}
