import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

/**
 * Isolated env for exercising the install/first-run bootstrap: a temp HOME (so any
 * user-scope tool wiring lands in the sandbox, never the real `~/.claude` etc.), a temp
 * global-config home, an empty PATH (so NO tool is detected — proving the pre-wire
 * happens anyway), and the suite's bootstrap-disable flag DELETED so the bootstrap
 * actually runs (spawnEnv sets it to keep every other test hermetic).
 */
function bootstrapEnv(home: string, ghome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...spawnEnv(),
    HOME: home,
    USERPROFILE: home,
    SHOWTAIL_HOME: ghome,
    PATH: '',
    Path: '',
  };
  delete env.SHOWTAIL_DISABLE_FIRST_RUN;
  return env;
}

function globalConfig(ghome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ghome, 'config.json'), 'utf8'));
}

describe('first-run bootstrap ("just works" on install)', () => {
  test('setup --first-run turns tracking on and pre-wires even an UNdetected tool', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      const r = runCli(dir, ['setup', '--first-run', '--json'], { env });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.ran).toBe(true);
      expect(out.autoInit).toBe(true);
      // Never-miss: PATH is empty (nothing detected) yet Claude's user-scope capture
      // hooks were pre-seeded, so a later `claude` install captures from session one.
      expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('setup --first-run is once-only (a re-run does nothing)', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      expect(
        JSON.parse(runCli(dir, ['setup', '--first-run', '--json'], { env }).stdout).ran,
      ).toBe(true);
      const again = runCli(dir, ['setup', '--first-run', '--json'], { env });
      expect(JSON.parse(again.stdout).ran).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a normal command bootstraps on first run, notice on stderr, --json stdout stays clean', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      // `matrix --json` works in any folder and is not on the bootstrap skip-list.
      const r = runCli(dir, ['matrix', '--json'], { env });
      expect(r.code).toBe(0);
      // stdout must be valid JSON — the notice must not leak into it.
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      // The bootstrap turned tracking on...
      expect(globalConfig(ghome).autoInit).toBe(true);
      // ...and surfaced the privacy notice on stderr.
      expect(r.stderr).toContain('Showtail is on');
      expect(r.stderr).toContain('showtail setup --off');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('`capabilities` is a pure probe — it never triggers the bootstrap', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      const r = runCli(dir, ['capabilities', '--json'], { env });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).autoInit).toBe(false);
      // A probe must have no side effects — no global config written.
      expect(existsSync(join(ghome, 'config.json'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('respects an explicit `setup --off` — a later command does NOT re-enable tracking', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      runCli(dir, ['setup', '--off', '--json'], { env });
      // The bootstrap must treat "explicitly off" as a decision already made.
      const r = runCli(dir, ['setup', '--first-run', '--json'], { env });
      expect(JSON.parse(r.stdout).ran).toBe(false);
      expect(globalConfig(ghome).autoInit).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('the disable hatch (SHOWTAIL_DISABLE_FIRST_RUN) suppresses the bootstrap', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = { ...bootstrapEnv(home, ghome), SHOWTAIL_DISABLE_FIRST_RUN: '1' };
      const r = runCli(dir, ['matrix', '--json'], { env });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain('Showtail is on');
      expect(existsSync(join(ghome, 'config.json'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('--help hides the get-started clutter but the lifecycle commands still run', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      const help = runCli(dir, ['--help'], { env });
      expect(help.stdout).not.toContain('Get started:');
      expect(help.stdout).toContain('Manage tracking (optional):');

      // `ensure` is hidden from help but must still work (the VS Code extension calls it).
      const ensured = runCli(dir, ['ensure', '--json'], { env });
      expect(ensured.code).toBe(0);
      expect(existsSync(join(dir, '.showtail'))).toBe(true);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
