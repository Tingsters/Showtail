import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllEvents } from '../src/core/events.ts';
import { appendJournal, JOURNAL_ENTRY_VERSION } from '../src/core/journal.ts';
import { writeObject } from '../src/core/objects.ts';
import { closeSession } from '../src/core/sessions.ts';
import {
  CONFIG_VERSION,
  ensureTrailId,
  migrateLegacySessions,
  pathsForRoot,
  readConfig,
  readSessions,
  trailIsNewerThanBinary,
  writeJson,
  type AuthorPaths,
} from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/** Rewrite a v4 trail back to the old on-disk shape: v3 config (no trailId), a
 *  single legacy `sessions.json` (no machineId), no `sessions/` shard dir. */
function downgradeToOldFormat(
  paths: ReturnType<typeof pathsForRoot>,
  author: AuthorPaths,
): void {
  const cfg = readConfig(paths);
  delete cfg.trailId;
  cfg.version = 3;
  writeJson(paths.config, cfg);
  rmSync(join(author.dir, 'sessions'), { recursive: true, force: true });
  writeJson(join(author.dir, 'sessions.json'), [
    { id: 'ses_open', startedAt: '2026-06-01T10:00:00.000Z' },
    {
      id: 'ses_closed',
      startedAt: '2026-06-01T09:00:00.000Z',
      endedAt: '2026-06-01T09:30:00.000Z',
    },
  ]);
}

/** Seed one prompt event in `sessionId` under THIS machine's journal shard. */
function seedEvent(author: AuthorPaths, sessionId: string): void {
  const ref = writeObject(author.shared, 'an old prompt');
  appendJournal(author, {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'event',
    id: 'evt_old',
    ts: '2026-06-01T10:01:00.000Z',
    type: 'prompt',
    tool: 'claude-code',
    conv: sessionId,
    actorSlug: author.slug,
    refs: [ref],
    textPreview: 'an old prompt',
    bytes: 13,
  });
}

describe('migration of existing (pre-0.11) trails', () => {
  test('single-machine: config upgrades to v4+trailId and legacy sessions consolidate', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const mid = author.machineId!;
      seedEvent(author, 'ses_open'); // a real event in the open session
      downgradeToOldFormat(paths, author);

      // Pre-conditions: old format.
      expect(readConfig(paths).version).toBe(3);
      expect(readConfig(paths).trailId).toBeUndefined();
      expect(existsSync(join(author.dir, 'sessions.json'))).toBe(true);

      // The new binary touches it.
      ensureTrailId(paths);
      migrateLegacySessions(author);

      // Config upgraded; old fields intact.
      const cfg = readConfig(paths);
      expect(cfg.version).toBe(CONFIG_VERSION);
      expect(cfg.trailId).toBeTruthy();

      // Legacy sessions consolidated into this machine's shard.
      expect(existsSync(join(author.dir, 'sessions.json'))).toBe(false);
      expect(existsSync(join(author.dir, 'sessions', `${mid}.json`))).toBe(true);
      const sessions = readSessions(author);
      expect(sessions.map((s) => s.id).sort()).toEqual(['ses_closed', 'ses_open']);
      expect(sessions.find((s) => s.id === 'ses_open')?.machineId).toBe(mid);

      // The previously-open session can now be closed (it carries a machineId).
      closeSession(author, 'ses_open', '2026-06-01T11:00:00.000Z');
      expect(readSessions(author).find((s) => s.id === 'ses_open')?.endedAt).toBeTruthy();

      // The event still renders.
      expect(readAllEvents(paths).some((e) => e.text === 'an old prompt')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('multi-machine: legacy sessions.json is left read-only (no mis-attribution)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      seedEvent(author, 'ses_open');
      downgradeToOldFormat(paths, author);
      // A second machine's journal shard makes this a shared, multi-machine trail.
      mkdirSync(join(author.dir, 'journal', 'machine-other'), { recursive: true });

      migrateLegacySessions(author);

      // Not consolidated: legacy file remains, and its sessions still merge on read.
      expect(existsSync(join(author.dir, 'sessions.json'))).toBe(true);
      expect(
        readSessions(author)
          .map((s) => s.id)
          .sort(),
      ).toEqual(['ses_closed', 'ses_open']);
    } finally {
      cleanup(dir);
    }
  });

  test('a trail written by a newer Showtail is flagged', () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      writeJson(join(dir, '.showtail', 'config.json'), {
        version: CONFIG_VERSION + 5,
        createdAt: '2026-06-01T00:00:00.000Z',
        settings: { git: false },
      });
      expect(trailIsNewerThanBinary(pathsForRoot(dir))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
