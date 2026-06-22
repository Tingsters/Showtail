import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli } from './helpers.ts';

const run = runCli;

describe('ensure', () => {
  test('initializes a trail and opens a session, idempotently', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');

      let r = run(dir, ['ensure', '--json']);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.created).toBe(true);
      expect(out.initialized).toBe(true);
      expect(out.anchorKind).toBe('cwd');
      expect(out.sessionId).toMatch(/^ses_/);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);

      // Second run is a no-op create and reuses the same open session.
      r = run(dir, ['ensure', '--json']);
      expect(r.code).toBe(0);
      const out2 = JSON.parse(r.stdout);
      expect(out2.created).toBe(false);
      expect(out2.sessionId).toBe(out.sessionId);
    } finally {
      cleanup(dir);
    }
  });

  test('anchors the trail at the git repo root, not a subdir', () => {
    const dir = makeTempDir();
    try {
      // A minimal git repo with a nested working subdir.
      expect(spawnSync('git', ['init'], { cwd: dir }).status).toBe(0);
      const sub = join(dir, 'src', 'deep');
      mkdirSync(sub, { recursive: true });

      const r = run(sub, ['ensure', '--json']);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.created).toBe(true);
      expect(out.anchorKind).toBe('git');
      // Trail lives at the repo root, and not duplicated in the subdir.
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);
      expect(existsSync(join(sub, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
