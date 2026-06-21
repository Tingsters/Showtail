import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { runInit } from '../src/commands/init.ts';
import {
  authorSlugs,
  ensureAuthor,
  readAllAuthors,
  readAuthor,
} from '../src/core/authors.ts';
import { authorPaths, pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir, seedAuthor } from './helpers.ts';

describe('authors', () => {
  test('runInit establishes the active student as an author folder', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      expect(authorSlugs(paths)).toEqual(['tester-at-example-com']);
      const author = readAuthor(authorPaths(paths, 'tester-at-example-com'));
      expect(author?.email).toBe('tester@example.com');
      expect(author?.name).toBe('Test Student');
    } finally {
      cleanup(dir);
    }
  });

  test('ensureAuthor is idempotent and never clobbers an existing author.json', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const a1 = ensureAuthor(paths, { email: 'tester@example.com', name: 'Renamed' });
      // The original record is preserved (createdAt + name untouched).
      expect(readAuthor(a1)?.name).toBe('Test Student');
      expect(authorSlugs(paths)).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('the roster is derived by scanning authors/ (no shared index file)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      seedAuthor(paths, 'bob@school.edu');
      seedAuthor(paths, 'carol@school.edu');

      expect(authorSlugs(paths)).toEqual([
        'bob-at-school-edu',
        'carol-at-school-edu',
        'tester-at-example-com',
      ]);
      expect(
        readAllAuthors(paths)
          .map((a) => a.email)
          .sort(),
      ).toEqual(['bob@school.edu', 'carol@school.edu', 'tester@example.com']);
      // There is deliberately no shared roster file to conflict on.
      expect(existsSync(`${paths.authorsDir}/index.json`)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
