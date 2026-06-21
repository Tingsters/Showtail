import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, spawnEnv } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

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
    PATH: '',
    Path: '',
  };
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
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
});
