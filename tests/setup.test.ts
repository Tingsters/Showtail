import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

/**
 * Spawn env with an isolated HOME and global home, and an empty PATH so tool
 * detection finds nothing — keeping the assertions deterministic regardless of
 * what's installed on the machine running the suite.
 */
function isolatedEnv(home: string, ghome: string): NodeJS.ProcessEnv {
  return {
    ...spawnEnv(),
    HOME: home,
    USERPROFILE: home,
    SHOWTAIL_HOME: ghome,
    // Pin the Antigravity/Gemini home too: IDE/CLI detection keys on geminiHome(),
    // so without this the spawned setup could inherit a real ~/.gemini and connect
    // tools the stubbed PATH was meant to hide.
    GEMINI_HOME: join(home, '.gemini'),
    PATH: '',
    Path: '',
  };
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return runCli(cwd, args, { env });
}

describe('setup', () => {
  test('turns on automatic tracking and writes the global config', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = isolatedEnv(home, ghome);
      const r = run(dir, ['setup', '--json'], env);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.autoInit).toBe(true);
      expect(typeof out.setupCompletedAt).toBe('string');
      // No tools on the stubbed PATH → nothing connected.
      expect(out.connected).toEqual([]);
      expect(existsSync(join(ghome, 'config.json'))).toBe(true);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('--off turns automatic tracking back off', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const env = isolatedEnv(home, ghome);
      run(dir, ['setup', '--json'], env);
      const r = run(dir, ['setup', '--off', '--json'], env);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).autoInit).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('--off explains that connected capture remains active', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const result = run(dir, ['setup', '--off'], isolatedEnv(home, ghome));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        'Automatic creation of new project trails is now OFF.',
      );
      expect(result.stdout).toContain(
        'Connected tools still capture in existing trails.',
      );
      expect(result.stdout).toContain('showtail disconnect <tool>');
      expect(result.stdout).not.toContain('Automatic tracking is now OFF.');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('human guidance distinguishes local ledger storage from project trails', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    try {
      const result = run(dir, ['setup'], isolatedEnv(home, ghome));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('machine-local inbox/ledger');
      expect(result.stdout).toContain('showtail disconnect <tool>');
      expect(result.stdout).not.toContain('everything stays local under .showtail');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
