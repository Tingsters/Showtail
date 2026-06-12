import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NotInitializedError,
  appendJsonl,
  findRoot,
  pathsForRoot,
  readJsonl,
  requirePaths,
  toRepoRelative,
  writeJson,
  readJson,
} from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('storage', () => {
  test('JSON round-trips', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'data.json');
      writeJson(file, { a: 1, b: ['x', 'y'] });
      expect(readJson<Record<string, unknown>>(file)).toEqual({ a: 1, b: ['x', 'y'] });
    } finally {
      cleanup(dir);
    }
  });

  test('JSONL appends and reads, skipping blank lines', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'log.jsonl');
      appendJsonl(file, { n: 1 });
      appendJsonl(file, { n: 2 });
      expect(readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      cleanup(dir);
    }
  });

  test('readJsonl of a missing file is empty', () => {
    const dir = makeTempDir();
    try {
      expect(readJsonl(join(dir, 'nope.jsonl'))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('findRoot walks up to the .showtail folder', () => {
    const dir = makeTempDir();
    try {
      const paths = pathsForRoot(dir);
      mkdirSync(paths.base, { recursive: true });
      const nested = join(dir, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      expect(findRoot(nested)).toBe(dir);
    } finally {
      cleanup(dir);
    }
  });

  test('requirePaths throws NotInitializedError when uninitialized', () => {
    const dir = makeTempDir();
    try {
      expect(() => requirePaths(dir)).toThrow(NotInitializedError);
    } finally {
      cleanup(dir);
    }
  });

  test('toRepoRelative produces clean forward-slash paths', () => {
    const dir = makeTempDir();
    try {
      expect(toRepoRelative(dir, join(dir, 'src', 'a.ts'))).toBe('src/a.ts');
      expect(toRepoRelative(dir, 'README.md')).toBe('README.md');
    } finally {
      cleanup(dir);
    }
  });
});
