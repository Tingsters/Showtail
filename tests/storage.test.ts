import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  findRoot,
  isPathUnder,
  readJsonl,
  toRepoRelative,
  writeJson,
  readJson,
} from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';
describe('storage', () => {
  test('isPathUnder handles a filesystem root without doubling its separator', () => {
    const root = parse(tmpdir()).root;
    expect(isPathUnder(join(root, 'child'), root)).toBe(true);
  });
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
  test('readJsonl of a missing file is empty', () => {
    const dir = makeTempDir();
    try {
      expect(readJsonl(join(dir, 'nope.jsonl'))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
  test('findRoot stops at SHOWTAIL_ROOT_CEILING and never escapes upward', () => {
    const outer = makeTempDir();
    try {
      // A real `.showtail` sits ABOVE the search start — mimicking a developer's
      // global `~/.showtail` above the OS temp dir that tests must never reach.
      mkdirSync(join(outer, '.showtail'), { recursive: true });
      const ceiling = join(outer, 'sandbox');
      const start = join(ceiling, 'project', 'src');
      mkdirSync(start, { recursive: true });
      const prev = process.env.SHOWTAIL_ROOT_CEILING;
      process.env.SHOWTAIL_ROOT_CEILING = ceiling;
      try {
        // Without the ceiling this resolves `outer` (the `.showtail` above).
        expect(findRoot(start)).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.SHOWTAIL_ROOT_CEILING;
        else process.env.SHOWTAIL_ROOT_CEILING = prev;
      }
    } finally {
      cleanup(outer);
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
