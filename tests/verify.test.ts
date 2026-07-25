import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent, removeEventsByBatch } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import {
  pathsForRoot,
  type AuthorPaths,
  type ShowtailPaths,
} from '../src/core/storage.ts';
import { readJournal } from '../src/core/journal.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { authorFor, cleanup, makeTempDir, runCli } from './helpers.ts';

/** Path to an author's first journal segment, ensuring the shard dir exists. */
function journalSegment(author: AuthorPaths): string {
  const dir = join(author.journalDir, author.machineId!);
  mkdirSync(dir, { recursive: true });
  return join(dir, '0001.log');
}

/** The file backing an object address (`sha256:<hex>` → `objects/<2>/<rest>`). */
function objectFile(paths: ShowtailPaths, ref: string): string {
  const hex = ref.slice(ref.indexOf(':') + 1);
  return join(paths.objectsDir, hex.slice(0, 2), hex.slice(2));
}

/** Read a journal segment as its raw lines (what a tamperer would hand-edit). */
function segmentLines(author: AuthorPaths): string[] {
  return readFileSync(journalSegment(author), 'utf8').trimEnd().split('\n');
}

function writeSegmentLines(author: AuthorPaths, lines: string[]): void {
  writeFileSync(journalSegment(author), lines.join('\n') + '\n', 'utf8');
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

  // The inversion this suite exists to guard: a student who keeps working on
  // their code after the last snapshot is doing exactly the right thing, and
  // must never be told their trail failed verification.
  test('a source file edited after its snapshot still passes (informational only)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      writeFileSync(join(dir, 'README.md'), '# Project');
      await addArtifact(author, { filePath: 'README.md' });

      writeFileSync(
        join(dir, 'README.md'),
        '# Project (kept working after the snapshot)',
      );
      const result = await verifyProject(paths);
      expect(result.ok).toBe(true);
      const snapshots = checkByName(result, 'file snapshots are accounted for');
      expect(snapshots.ok).toBe(true);
      expect(snapshots.details.join('\n')).toContain('edited since their last snapshot');
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

describe('verify: tamper detection', () => {
  test('a hand-edited stored object no longer matches its address', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const { event } = await logEvent(author, {
        type: 'prompt',
        text: 'Write the sorting function for me',
      });
      expect(event.text).toContain('sorting');

      // Rewrite the stored prompt text to invent a prompt that was never sent.
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      writeFileSync(objectFile(paths, ref), 'Explain how quicksort works', 'utf8');

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const objects = checkByName(result, 'stored content matches its address');
      expect(objects.ok).toBe(false);
      expect(objects.details.join('\n')).toContain('tampered');
      expect(objects.details.join('\n')).toContain(ref);
    } finally {
      cleanup(dir);
    }
  });

  test('a deleted object is reported as missing from the store', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'A prompt worth hiding' });
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      rmSync(objectFile(paths, ref));

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const objects = checkByName(result, 'stored content matches its address');
      expect(objects.ok).toBe(false);
      expect(objects.details.join('\n')).toContain('missing');
    } finally {
      cleanup(dir);
    }
  });

  test('a hand-edited journal line breaks the hash chain', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      // Doctor the middle line in place — the classic "I said something smarter".
      const lines = segmentLines(author);
      expect(lines.length).toBe(3);
      const doctored = JSON.parse(lines[1]!) as Record<string, unknown>;
      doctored.textPreview = 'a much better prompt I never actually sent';
      lines[1] = JSON.stringify(doctored);
      writeSegmentLines(author, lines);

      const result = await verifyProject(paths);
      expect(result.ok).toBe(false);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(false);
      // The break surfaces at the entry *after* the edited one.
      expect(chain.details.join('\n')).toContain('entry 3');
    } finally {
      cleanup(dir);
    }
  });

  test('deleting a journal line breaks the hash chain', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'embarrassing prompt' });
      await logEvent(author, { type: 'prompt', text: 'third prompt' });

      const lines = segmentLines(author);
      writeSegmentLines(author, [lines[0]!, lines[2]!]);

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('import undo re-chains the journal and still verifies', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'my own prompt' });
      await logEvent(author, {
        type: 'prompt',
        text: 'imported prompt',
        batchId: 'batch-1',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'imported reply',
        batchId: 'batch-1',
      });
      await logEvent(author, { type: 'prompt', text: 'another of my own' });

      expect(removeEventsByBatch(author, 'batch-1')).toBe(2);
      expect(readJournal(author).length).toBe(2);

      const result = await verifyProject(paths);
      expect(checkByName(result, 'journal chain is unbroken').ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a trail written before chaining is informational, not a failure', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'first prompt' });
      await logEvent(author, { type: 'prompt', text: 'second prompt' });

      // Strip every `prev`: exactly what an older Showtail's journal looks like.
      writeSegmentLines(
        author,
        segmentLines(author).map((line) => {
          const { prev: _dropped, ...rest } = JSON.parse(line) as Record<string, unknown>;
          return JSON.stringify(rest);
        }),
      );

      const result = await verifyProject(paths);
      const chain = checkByName(result, 'journal chain is unbroken');
      expect(chain.ok).toBe(true);
      expect(chain.details.join('\n')).toContain('older Showtail');
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('verify --json', () => {
  test('emits parseable JSON and exits 0 on a clean trail', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      await logEvent(authorFor(paths), { type: 'prompt', text: 'hello' });

      const res = runCli(dir, ['verify', '--json']);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.checks)).toBe(true);
      for (const check of parsed.checks) {
        expect(typeof check.name).toBe('string');
        expect(typeof check.ok).toBe('boolean');
        expect(Array.isArray(check.details)).toBe(true);
      }
      expect(parsed.checks.map((c: { name: string }) => c.name)).toContain(
        'journal chain is unbroken',
      );
      expect(parsed.checks.map((c: { name: string }) => c.name)).toContain(
        'stored content matches its address',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('still exits 3 when a check fails', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, { type: 'prompt', text: 'the real prompt' });
      const ref = readJournal(author).find((e) => e.refs)!.refs![0]!;
      writeFileSync(objectFile(paths, ref), 'a prompt I never sent', 'utf8');

      const res = runCli(dir, ['verify', '--json']);
      expect(res.code).toBe(3);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(false);
      const failed = parsed.checks.filter((c: { ok: boolean }) => !c.ok);
      expect(failed.map((c: { name: string }) => c.name)).toContain(
        'stored content matches its address',
      );
    } finally {
      cleanup(dir);
    }
  });
});
