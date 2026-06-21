import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { logEvent } from '../src/core/events.ts';
import { readObject, writeObject } from '../src/core/objects.ts';
import { appendJournal, pathsForRoot, readJournal } from '../src/core/storage.ts';
import { buildReportData, renderHtml } from '../src/core/report.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/** Recursively list files under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe('object store + journal', () => {
  test('writeObject dedups identical content and shards by prefix', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);

      const a = writeObject(paths, 'hello world');
      const b = writeObject(paths, 'hello world');
      const c = writeObject(paths, 'different');
      expect(a).toBe(b); // same content → same address
      expect(a).not.toBe(c);
      expect(readObject(paths, a)).toBe('hello world');

      // Sharded: objects live under a two-char prefix directory.
      const files = walk(paths.objectsDir);
      expect(files.length).toBe(2); // two distinct contents, dedup kept it to two
      for (const f of files) {
        const rel = f.slice(paths.objectsDir.length + 1).replace(/\\/g, '/');
        expect(rel).toMatch(/^[0-9a-f]{2}\//);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('journal appends in order and rotates segment names', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      appendJournal(author, {
        v: 1,
        kind: 'event',
        id: 'a',
        ts: '2026-01-01T00:00:00Z',
        type: 'prompt',
      });
      appendJournal(author, {
        v: 1,
        kind: 'event',
        id: 'b',
        ts: '2026-01-01T00:01:00Z',
        type: 'prompt',
      });
      const entries = readJournal(author);
      expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
      // Segments live under authors/<slug>/journal/<machineId>/0001.log.
      expect(existsSync(join(author.journalDir, author.machineId!, '0001.log'))).toBe(
        true,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('secrets are redacted before storing — never on disk or in the report', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const secret = 'AKIAIOSFODNN7EXAMPLE';
      await logEvent(author, { type: 'prompt', text: `deploy with key ${secret}` });

      // Not in any object file...
      for (const f of walk(paths.objectsDir)) {
        expect(readFileSync(f, 'utf8')).not.toContain(secret);
      }
      // ...not in the journal...
      expect(JSON.stringify(readJournal(author))).not.toContain(secret);
      // ...and not in the rendered report (which counts the redaction).
      const data = buildReportData(paths);
      expect(data.redactionCount).toBeGreaterThan(0);
      expect(renderHtml(data)).not.toContain(secret);
    } finally {
      cleanup(dir);
    }
  });

  test('no human-readable file lists a conversation; objects are opaquely named', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      await logEvent(author, {
        type: 'prompt',
        text: 'a memorable unique phrase zylophone',
      });
      // Object filenames are hashes (no readable names).
      for (const f of walk(paths.objectsDir)) {
        expect(f).not.toContain('zylophone');
      }
    } finally {
      cleanup(dir);
    }
  });
});
