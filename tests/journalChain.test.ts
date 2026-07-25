/**
 * The journal's hash chain and the object store's self-check — the two
 * mechanisms that make the trail tamper-evident. `verify`'s user-facing
 * behavior is covered in verify.test.ts; this file pins the primitives.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { logEvent } from '../src/core/events.ts';
import {
  appendJournal,
  checkChain,
  entryHash,
  JOURNAL_ENTRY_VERSION,
  readJournalShards,
  rechainEntries,
} from '../src/core/journal.ts';
import { checkObjects, writeObject } from '../src/core/objects.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir, seedAuthor } from './helpers.ts';

describe('journal hash chain', () => {
  test('each appended entry links to the one before it, per shard', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      await logEvent(author, { type: 'prompt', text: 'one' });
      await logEvent(author, { type: 'prompt', text: 'two' });
      await logEvent(author, { type: 'prompt', text: 'three' });

      const shards = readJournalShards(author);
      expect(shards.length).toBe(1);
      const entries = shards[0]!.entries;
      expect(entries[0]!.prev).toBeUndefined(); // A chain starts unanchored.
      expect(entries[1]!.prev).toBe(entryHash(entries[0]!));
      expect(entries[2]!.prev).toBe(entryHash(entries[1]!));
      expect(checkChain(entries)).toEqual({ breaks: [], unchained: 0 });
    } finally {
      cleanup(dir);
    }
  });

  test('the chain carries across a segment rollover', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      await logEvent(author, { type: 'prompt', text: 'in segment one' });

      // Simulate the rollover `activeSegment` performs at the size cap: a fresh,
      // empty segment. The next append must still link back to segment one's tail.
      const shardDir = join(author.journalDir, author.machineId!);
      writeFileSync(join(shardDir, '0002.log'), '', 'utf8');
      await logEvent(author, { type: 'prompt', text: 'in segment two' });

      const entries = readJournalShards(author)[0]!.entries;
      expect(entries.length).toBe(2);
      expect(entries[1]!.prev).toBe(entryHash(entries[0]!));
      expect(checkChain(entries).breaks).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('two machines chain independently, so neither shard sees a break', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const laptop = authorFor(paths);
      // The same student, appending from a second machine (a merged trail).
      const desktop = { ...laptop, machineId: 'other-machine' };
      await logEvent(laptop, { type: 'prompt', text: 'from the laptop' });
      await logEvent(desktop, { type: 'prompt', text: 'from the desktop' });
      await logEvent(laptop, { type: 'prompt', text: 'laptop again' });

      const shards = readJournalShards(laptop);
      expect(shards.length).toBe(2);
      for (const shard of shards) {
        expect(shard.entries[0]!.prev).toBeUndefined();
        expect(checkChain(shard.entries)).toEqual({ breaks: [], unchained: 0 });
      }
    } finally {
      cleanup(dir);
    }
  });

  test('entries with no prev are counted as unchained, not broken', () => {
    const legacy = [
      { v: 1, id: 'a', ts: '2026-01-01T00:00:00.000Z', type: 'prompt' as const },
      { v: 1, id: 'b', ts: '2026-01-01T00:01:00.000Z', type: 'prompt' as const },
      { v: 1, id: 'c', ts: '2026-01-01T00:02:00.000Z', type: 'prompt' as const },
    ];
    expect(checkChain(legacy)).toEqual({ breaks: [], unchained: 2 });
  });

  test('rechainEntries relinks a filtered run into a valid chain', () => {
    const entries = rechainEntries([
      { v: 1, id: 'a', ts: '2026-01-01T00:00:00.000Z', type: 'prompt' },
      { v: 1, id: 'b', ts: '2026-01-01T00:01:00.000Z', type: 'prompt', prev: 'stale' },
      { v: 1, id: 'c', ts: '2026-01-01T00:02:00.000Z', type: 'prompt', prev: 'stale' },
    ]);
    expect(entries[0]!.prev).toBeUndefined();
    expect(entries[1]!.prev).toBe(entryHash(entries[0]!));
    expect(entries[2]!.prev).toBe(entryHash(entries[1]!));
    expect(checkChain(entries)).toEqual({ breaks: [], unchained: 0 });
  });

  test('a second author’s journal chains on its own', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const other = seedAuthor(paths, 'bob@example.com');
      appendJournal(other, {
        v: JOURNAL_ENTRY_VERSION,
        kind: 'artifact',
        id: 'art_1',
        ts: '2026-01-01T00:00:00.000Z',
        type: 'artifact',
        path: 'a.txt',
        sha256: 'abc',
      });
      appendJournal(other, {
        v: JOURNAL_ENTRY_VERSION,
        kind: 'artifact',
        id: 'art_2',
        ts: '2026-01-01T00:01:00.000Z',
        type: 'artifact',
        path: 'a.txt',
        sha256: 'def',
      });
      const entries = readJournalShards(other)[0]!.entries;
      expect(entries[1]!.prev).toBe(entryHash(entries[0]!));
    } finally {
      cleanup(dir);
    }
  });
});

describe('checkObjects', () => {
  test('reports ok for untouched objects and mismatch for an edited one', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const good = writeObject(paths, 'the prompt I actually sent');
      const bad = writeObject(paths, 'another prompt');
      expect(checkObjects(paths).every((c) => c.status === 'ok')).toBe(true);

      const hex = bad.slice(bad.indexOf(':') + 1);
      writeFileSync(
        join(paths.objectsDir, hex.slice(0, 2), hex.slice(2)),
        'something I wish I had asked',
        'utf8',
      );

      const results = checkObjects(paths);
      expect(results.find((c) => c.ref === good)!.status).toBe('ok');
      expect(results.find((c) => c.ref === bad)!.status).toBe('mismatch');
    } finally {
      cleanup(dir);
    }
  });

  test('an empty store is simply empty', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      expect(checkObjects(pathsForRoot(dir))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
