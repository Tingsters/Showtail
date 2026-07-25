import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

/**
 * Isolated env for exercising the install/first-run bootstrap: a temp HOME (so any
 * user-scope tool wiring lands in the sandbox, never the real `~/.claude` etc.), a temp
 * global-config home, an empty PATH (so NO tool is detected — proving the pre-wire
 * happens anyway), and the suite's bootstrap-disable flag DELETED so the bootstrap
 * actually runs (spawnEnv sets it to keep every other test hermetic).
 *
 * Each host tool's config-dir override is re-pointed *inside* this temp HOME. Those
 * overrides (`CLAUDE_CONFIG_DIR` and friends, pinned suite-wide in setup.ts) beat
 * HOME, so without this the pre-wire would land in the shared suite sandbox and the
 * `<home>/.claude/settings.json` assertions below would test nothing.
 */
function bootstrapEnv(home: string, ghome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...spawnEnv(),
    HOME: home,
    USERPROFILE: home,
    SHOWTAIL_HOME: ghome,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    COPILOT_HOME: join(home, '.copilot'),
    GEMINI_HOME: join(home, '.gemini'),
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

  test('the disable hatch also suppresses `setup --first-run`, writing nothing to HOME', () => {
    // The hatch is checked inside ensureFirstRunSetup, but `setup --first-run` — the
    // command install.sh actually runs — used to seed a machine identity *before*
    // calling it, so an environment that had explicitly opted out still got written to.
    // That matters wherever install.sh runs somewhere disposable: a CI runner (the
    // GitHub Action hit this), a Docker layer, a classroom image.
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      // A per-test identity home, so it starts EMPTY. The suite-wide pin in setup.ts is
      // already populated by other tests, and `seedRealIdentityAtInstall` returns early
      // when an identity is cached — against that, this test would pass either way.
      const idHome = join(home, 'identity');
      const env = {
        ...bootstrapEnv(home, ghome),
        SHOWTAIL_IDENTITY_HOME: idHome,
        SHOWTAIL_DISABLE_FIRST_RUN: '1',
      };
      const r = runCli(dir, ['setup', '--first-run'], { env });
      expect(r.code).toBe(0);
      expect(existsSync(join(ghome, 'config.json'))).toBe(false);
      // The seeding step must not have run: no identity cache written.
      expect(existsSync(join(idHome, 'identity.json'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('an integration fix in a newer Showtail reaches already-installed hooks WITHOUT any tool hook firing', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = bootstrapEnv(home, ghome);
      // Set up: pre-wires Claude (prewireSafe) and stamps the current wiringVersion.
      runCli(dir, ['setup', '--first-run', '--json'], { env });
      expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);

      // Simulate: student already set up on an OLD Showtail (stale wiringVersion), then a
      // tool update broke the hooks and a NEWER Showtail with the fix is now running.
      const cfg = globalConfig(ghome);
      cfg.wiringVersion = '0.0.0';
      writeFileSync(join(ghome, 'config.json'), JSON.stringify(cfg));
      // Wipe Showtail's hooks from the on-disk config to prove the refresh re-applies
      // them (the tool's own hooks are NOT relied on to fire the fix).
      writeFileSync(join(home, '.claude', 'settings.json'), '{"other":"kept"}');

      // (a) A plain CLI command (like the AI skill's `showtail status`, or `report`) —
      //     NOT a tool hook — must carry the fix to the on-disk hooks.
      const r = runCli(dir, ['matrix', '--json'], { env });
      expect(r.code).toBe(0);
      expect(globalConfig(ghome).wiringVersion).not.toBe('0.0.0'); // re-stamped to current
      const rewritten = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
      expect(rewritten).toContain('showtail hook'); // Showtail's hooks re-applied
      expect(rewritten).toContain('kept'); // merge is non-destructive
      expect(r.stderr).toContain('updated its capture integration');

      // (b) The installer path (re-running on upgrade) also refreshes stale wiring.
      const cfg2 = globalConfig(ghome);
      cfg2.wiringVersion = '0.0.0';
      writeFileSync(join(ghome, 'config.json'), JSON.stringify(cfg2));
      const up = runCli(dir, ['setup', '--first-run', '--json'], { env });
      expect(up.code).toBe(0);
      expect(JSON.parse(up.stdout).refreshed).toContain('claude');
      expect(globalConfig(ghome).wiringVersion).not.toBe('0.0.0');
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
