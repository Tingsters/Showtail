import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { reattachLedgerSession, runReattach } from '../src/commands/reattach.ts';
import { readAllEvents } from '../src/core/events.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerSession,
  resolveLedgerSessionId,
} from '../src/core/ledger.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

function promptTexts(root: string): string[] {
  return readAllEvents(pathsForRoot(root))
    .filter((e) => e.type === 'prompt')
    .map((e) => e.text);
}

describe('reattachLedgerSession core (place + move)', () => {
  test('places into a fresh repo, then a move lifts it out of the old one', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's1',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'movable core work',
      });

      // Place into repoA (creates the trail).
      const placed = await reattachLedgerSession(session, repoA);
      expect(placed.root).toBe(resolve(repoA));
      expect(placed.projected).toBe(1);
      expect(placed.movedFrom).toEqual([]);
      expect(promptTexts(repoA)).toContain('movable core work');
      expect(readLedgerSession(session.id)?.status).toBe('placed');

      // Move to repoB — re-read the session so its target list is current.
      const updated = resolveLedgerSessionId(session.id)!;
      const moved = await reattachLedgerSession(updated, repoB);
      expect(moved.projected).toBe(1);
      expect(moved.movedFrom.length).toBe(1); // lifted out of repoA
      expect(promptTexts(repoB)).toContain('movable core work');
      // ...and removed from repoA.
      expect(promptTexts(repoA)).not.toContain('movable core work');

      // The ledger now points only at repoB.
      const finalTargets = readLedgerSession(session.id)?.targets ?? [];
      expect(finalTargets.length).toBe(1);
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
    }
  });

  test('runReattach rejects an unknown session id with a helpful error', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await expect(runReattach('led_does_not_exist', { to: dir })).rejects.toThrow(
        /No ledger session/,
      );
    } finally {
      cleanup(home);
      cleanup(dir);
    }
  });
});
