import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allLedgerSessions,
  appendLedgerRecord,
  endLedgerSession,
  ensureLedgerSession,
  markInbox,
  markPlaced,
  readLedgerIndex,
  readLedgerRecords,
  readLedgerSession,
  resolveLedgerSessionId,
  setLedgerTurn,
  unlinkPlacement,
  unplacedSessions,
} from '../src/core/ledger.ts';
import { cleanup, makeTempDir } from './helpers.ts';

// The ledger reads its location from SHOWTAIL_HOME on every call, so each test
// points it at a throwaway dir and restores the previous value after.
let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  process.env.SHOWTAIL_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
  cleanup(home);
});

describe('ledger session keying', () => {
  test('same (tool, native id) returns the same open session', () => {
    const a = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    const b = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    expect(b.id).toBe(a.id);
    expect(allLedgerSessions().length).toBe(1);
  });

  test('different native ids get different sessions', () => {
    const a = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    const b = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's2' });
    expect(b.id).not.toBe(a.id);
    expect(allLedgerSessions().length).toBe(2);
  });

  test('a continuation after the session ended gets a fresh session', () => {
    const a = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    endLedgerSession(a.id);
    const b = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    expect(b.id).not.toBe(a.id);
    expect(readLedgerSession(a.id)?.endedAt).toBeTruthy();
  });
});

describe('ledger records', () => {
  test('append/read round-trips in order with turn linkage', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    const p = appendLedgerRecord(s.id, {
      kind: 'prompt',
      tool: 'claude-code',
      text: 'do X',
    });
    setLedgerTurn(s.id, p.id);
    appendLedgerRecord(s.id, {
      kind: 'edit',
      tool: 'claude-code',
      file: '/abs/file.ts',
      diff: '+ added',
      turnKey: p.id,
    });
    const recs = readLedgerRecords(s.id);
    expect(recs.map((r) => r.kind)).toEqual(['prompt', 'edit']);
    expect(recs[1]!.turnKey).toBe(p.id);
    expect(readLedgerSession(s.id)?.currentTurnKey).toBe(p.id);
  });
});

/** Create a real (minimal) trail dir whose config carries `trailId`, returning its root. */
function makeTrail(trailId: string): string {
  const root = makeTempDir();
  mkdirSync(join(root, '.showtail'), { recursive: true });
  writeFileSync(
    join(root, '.showtail', 'config.json'),
    JSON.stringify({ version: 4, trailId }) + '\n',
  );
  return root;
}

describe('placement and the inbox', () => {
  test('a fresh session is unplaced; placing into a live trail removes it from the inbox', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    expect(unplacedSessions({ includeHidden: true }).map((x) => x.id)).toContain(s.id);

    const root = makeTrail('trl_1');
    markPlaced(s.id, 'trl_1', root);
    expect(readLedgerSession(s.id)?.status).toBe('placed');
    expect(unplacedSessions({ includeHidden: true }).map((x) => x.id)).not.toContain(
      s.id,
    );
    cleanup(root);
  });

  test('a placed session whose trail no longer exists resurfaces as target-missing', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    // Point at a path that has no .showtail/config.json with this trailId.
    markPlaced(s.id, 'trl_gone', makeTempDir() + '/deleted-repo');
    const surfaced = unplacedSessions({ includeHidden: true }).find((x) => x.id === s.id);
    expect(surfaced?.targetMissing).toBe(true);
  });

  test('a diverged trailId (merge) is reconciled, not flagged target-missing', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    const root = makeTrail('trl_orig');
    markPlaced(s.id, 'trl_orig', root);
    expect(unplacedSessions({ includeHidden: true }).map((x) => x.id)).not.toContain(
      s.id,
    );

    // Simulate a merge picking the other clone's trailId for the SAME path.
    writeFileSync(
      join(root, '.showtail', 'config.json'),
      JSON.stringify({ version: 4, trailId: 'trl_merged' }) + '\n',
    );

    // The session is still alive (a valid trail sits at the path)...
    const surfaced = unplacedSessions({ includeHidden: true }).find((x) => x.id === s.id);
    expect(surfaced).toBeUndefined();
    // ...and the placement has been repointed to the path's current trailId.
    expect(readLedgerSession(s.id)?.targets?.[0]?.trailId).toBe('trl_merged');
    const idx = readLedgerIndex();
    expect(idx.trails['trl_merged']).toBeTruthy();
    expect(idx.trails['trl_orig']).toBeUndefined();
    cleanup(root);
  });

  test('markInbox never demotes an already-placed session', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    markPlaced(s.id, 'trl_1', '/repo/a');
    markInbox(s.id);
    expect(readLedgerSession(s.id)?.status).toBe('placed');
  });

  test('unlinking the last placement returns a session to the inbox', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    markPlaced(s.id, 'trl_1', '/repo/a');
    unlinkPlacement(s.id, 'trl_1');
    expect(readLedgerSession(s.id)?.status).toBe('inbox');
  });
});

describe('id resolution', () => {
  test('resolves by full id and by unambiguous prefix', () => {
    const s = ensureLedgerSession({ tool: 'claude-code', nativeSessionId: 's1' });
    expect(resolveLedgerSessionId(s.id)?.id).toBe(s.id);
    expect(resolveLedgerSessionId(s.id.slice(0, 10))?.id).toBe(s.id);
    expect(resolveLedgerSessionId('led_does_not_exist')).toBeNull();
  });
});

describe('isolation', () => {
  test('a fresh SHOWTAIL_HOME starts with an empty ledger', () => {
    expect(existsSync(home)).toBe(true);
    expect(allLedgerSessions()).toEqual([]);
    // sanity: removing the home really clears it for the next test
    rmSync(home, { recursive: true, force: true });
    expect(allLedgerSessions()).toEqual([]);
  });
});
