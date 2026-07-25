import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

/**
 * Create a throwaway temp directory and return its path.
 *
 * The owning pid is baked into the name (`showtail-test-<pid>-XXXXXX`) purely so
 * the startup sweep in tests/setup.ts can reap the ones this run leaks. The
 * `cleanup(dir)` call in each test's `finally` is still the primary mechanism,
 * but a suite killed by a signal or a timeout never reaches it — and with an
 * anonymous name those orphans are indistinguishable from a *concurrent* run's
 * live dirs, so nothing could ever safely delete them and they just accumulated
 * (thousands, on a machine that runs the suite all day). With the pid in the
 * name a later run can tell "owner is dead" from "owner is still working".
 */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), `showtail-test-${process.pid}-`));
}

/**
 * The on-disk shape of a {@link stubCli} script for one platform: the filename
 * extension a launcher will actually execute there, the script text, and the mode
 * to chmod it to (null where chmod is meaningless).
 *
 * Split out from `stubCli` so the Windows branch can be asserted from a POSIX
 * machine — the batch text is the half of this helper CI can't exercise until the
 * windows leg runs, so at least its *shape* is pinned by a test everywhere.
 */
export function stubCliScript(
  recordPath: string,
  platform: NodeJS.Platform = process.platform,
): { ext: string; body: string; mode: number | null } {
  if (platform === 'win32') {
    // CreateProcess can't launch a `#!/bin/sh` file and chmod is a no-op on
    // Windows, so the stub has to be a batch file — which is also what a real VS
    // Code / Antigravity install ships there (`code.cmd`, `antigravity-ide.cmd`),
    // so this exercises the same spawn shape production hits.
    //
    // `%*` is NOT used: it hands back the raw, still-quoted command tail, whereas
    // the sh branch emits one *dequoted* argument per line. The shift loop with
    // `%~1` reproduces that exactly, so `toContain(...)` assertions read the same
    // on both platforms. Batch `echo` writes CRLF rather than LF; that only ever
    // adds a trailing `\r` per line, which no assertion spans.
    const body = [
      '@echo off',
      'setlocal',
      `set "REC=${recordPath}"`,
      'type nul>"%REC%"', // an empty record still beats ENOENT when argv is empty
      ':showtail_stub_arg',
      'if "%~1"=="" goto showtail_stub_done',
      '>>"%REC%" echo(%~1', // redirect first: keeps a trailing digit out of the fd
      'shift',
      'goto showtail_stub_arg',
      ':showtail_stub_done',
      'endlocal',
      'exit /b 0',
      '',
    ].join('\r\n'); // cmd.exe is only reliably LF-tolerant by accident; be explicit
    return { ext: '.cmd', body, mode: null };
  }
  return {
    ext: '.sh',
    body: `#!/bin/sh\nprintf '%s\\n' "$@" > "${recordPath}"\nexit 0\n`,
    mode: 0o755,
  };
}

/**
 * Write an executable stub CLI named `<name><ext>` into `dir` that records its
 * argv — one dequoted argument per line — to `recordPath` and exits 0, and return
 * its path. Used to stand in for `code` / `antigravity-ide` in the extension-install
 * tests, which set `SHOWTAIL_VSCODE_CLI` / `SHOWTAIL_ANTIGRAVITY_CLI` to the
 * returned path. The extension is platform-chosen (see {@link stubCliScript}), so
 * callers must use the returned path rather than composing one.
 */
export function stubCli(dir: string, recordPath: string, name = 'code-stub'): string {
  const { ext, body, mode } = stubCliScript(recordPath);
  const p = join(dir, name + ext);
  writeFileSync(p, body);
  if (mode !== null) chmodSync(p, mode);
  return p;
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
