import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot, type AuthorPaths } from '../src/core/storage.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/** Path to an author's first journal segment, ensuring the shard dir exists. */
function journalSegment(author: AuthorPaths): string {
  const dir = join(author.journalDir, author.machineId!);
  mkdirSync(dir, { recursive: true });
  return join(dir, '0001.log');
}

function checkByName(result: Awaited<ReturnType<typeof verifyProject>>, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

describe('verify', () => {
  test('a clean project passes every check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, { type: 'prompt', text: 'Help me plan the project' });
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(author, { filePath: 'README.md' });

      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a changed artifact fails the hash check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(author, { filePath: 'README.md' });

      writeFileSync(join(dir, 'README.md'), '# Project (edited after snapshot)');
      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'artifact hashes match current files').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a corrupt journal line fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      // Write a broken line directly into the journal.
      appendFileSync(journalSegment(author), 'this is not json\n');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'journal entries are valid').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('an event missing required fields fails the validity check', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      appendFileSync(
        journalSegment(author),
        JSON.stringify({ id: 'x', type: 'banana', actorSlug: author.slug }) + '\n',
      );

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      expect(checkByName(result, 'journal entries are valid').ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
