import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { discoverShowtailProjects } from '../src/core/projectDiscovery.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('bulk project discovery', () => {
  test('finds nested project trails and skips a home catch-all', async () => {
    const home = makeTempDir();
    try {
      const first = join(home, 'projects', 'one');
      const second = join(home, 'courses', 'week', 'two');
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      await runInit({ cwd: first });
      await runInit({ cwd: second });
      mkdirSync(join(home, '.showtail'), { recursive: true });

      const result = discoverShowtailProjects({ home });
      expect(result.projects.map((project) => project.root).sort()).toEqual(
        [first, second].sort(),
      );
      expect(result.projects.some((project) => project.root === home)).toBe(false);
    } finally {
      cleanup(home);
    }
  });
});
