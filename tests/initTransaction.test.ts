import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureInitialized } from '../src/commands/init.ts';
import { CaptureInterruptedError } from '../src/core/captureGuard.ts';
import { readConfig, writeConfig } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function stagingPaths(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name.startsWith('.showtail.init-'))
    .map((name) => join(root, name));
}

const interruptedStages: Array<{
  name: string;
  reached: (base: string) => boolean;
}> = [
  {
    name: 'staging root creation',
    reached: (base) => !existsSync(join(base, 'authors')),
  },
  {
    name: 'authors directory creation',
    reached: (base) =>
      existsSync(join(base, 'authors')) && !existsSync(join(base, 'objects')),
  },
  {
    name: 'objects directory creation',
    reached: (base) =>
      existsSync(join(base, 'objects')) && !existsSync(join(base, 'reports')),
  },
  {
    name: 'reports directory creation',
    reached: (base) =>
      existsSync(join(base, 'reports')) && !existsSync(join(base, 'config.json')),
  },
  {
    name: 'config write',
    reached: (base) =>
      existsSync(join(base, 'config.json')) && !existsSync(join(base, 'state.json')),
  },
  {
    name: 'state write',
    reached: (base) =>
      existsSync(join(base, 'state.json')) && !existsSync(join(base, '.gitattributes')),
  },
  {
    name: 'gitattributes write',
    reached: (base) =>
      existsSync(join(base, '.gitattributes')) && !existsSync(join(base, '.gitignore')),
  },
  {
    name: 'gitignore write',
    reached: (base) => existsSync(join(base, '.gitignore')),
  },
];

describe('transactional initialization', () => {
  test('keeps the public trail absent until the complete staging tree is published', async () => {
    const dir = makeTempDir();
    try {
      const observations: Array<{ published: boolean; staging: number }> = [];
      const result = await ensureInitialized(dir, {
        continueCapture: () => {
          observations.push({
            published: existsSync(join(dir, '.showtail')),
            staging: stagingPaths(dir).length,
          });
          return true;
        },
      });

      expect(result.created).toBe(true);
      expect(observations.some((observation) => observation.staging > 0)).toBe(true);
      expect(
        observations.every(
          (observation) => observation.staging === 0 || !observation.published,
        ),
      ).toBe(true);
      expect(observations.at(-1)?.published).toBe(true);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);
      expect(existsSync(join(dir, '.showtail', 'state.json'))).toBe(true);
      expect(existsSync(join(dir, '.showtail', '.gitattributes'))).toBe(true);
      expect(existsSync(join(dir, '.showtail', '.gitignore'))).toBe(true);
      expect(stagingPaths(dir)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  for (const stage of interruptedStages) {
    test(`removes private staging after interruption following ${stage.name}`, async () => {
      const dir = makeTempDir();
      try {
        let interrupted = false;
        const pending = ensureInitialized(dir, {
          initialization: {
            mode: 'automatic',
            evidence: 'cwd',
            ledgerSessionId: 'led_init_transaction',
          },
          continueCapture: () => {
            const [base] = stagingPaths(dir);
            if (base && stage.reached(base)) {
              interrupted = true;
              return false;
            }
            return true;
          },
        });

        await expect(pending).rejects.toBeInstanceOf(CaptureInterruptedError);
        expect(interrupted).toBe(true);
        expect(existsSync(join(dir, '.showtail'))).toBe(false);
        expect(stagingPaths(dir)).toEqual([]);
      } finally {
        cleanup(dir);
      }
    });
  }

  test('adopts and preserves a complete trail published by another initializer', async () => {
    const dir = makeTempDir();
    const winnerRoot = makeTempDir();
    try {
      const winner = await ensureInitialized(winnerRoot);
      const winnerConfig = readConfig(winner.paths);
      winnerConfig.anchor = resolve(dir);
      writeConfig(winner.paths, winnerConfig);
      writeFileSync(join(winner.paths.base, 'winner.txt'), 'published first\n', 'utf8');

      let publishedWinner = false;
      const result = await ensureInitialized(dir, {
        continueCapture: () => {
          const [base] = stagingPaths(dir);
          if (
            !publishedWinner &&
            base &&
            existsSync(join(base, '.gitignore')) &&
            !existsSync(join(dir, '.showtail'))
          ) {
            renameSync(winner.paths.base, join(dir, '.showtail'));
            publishedWinner = true;
          }
          return true;
        },
      });

      expect(publishedWinner).toBe(true);
      expect(result.created).toBe(false);
      expect(readConfig(result.paths).trailId).toBe(winnerConfig.trailId);
      expect(readFileSync(join(result.paths.base, 'winner.txt'), 'utf8')).toBe(
        'published first\n',
      );
      expect(existsSync(winner.paths.base)).toBe(false);
      expect(stagingPaths(dir)).toEqual([]);
    } finally {
      cleanup(dir);
      cleanup(winnerRoot);
    }
  });
});
