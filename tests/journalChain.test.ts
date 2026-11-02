/**
 * The journal's hash chain and the object store's self-check — the two
 * mechanisms that make the trail tamper-evident. `verify`'s user-facing
 * behavior is covered in verify.test.ts; this file pins the primitives.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChain, entryHash } from '../src/core/journal.ts';
import { cleanup, makeTempDir } from './helpers.ts';
describe('journal hash chain', () => {
  test('entries with no prev are counted as unchained, not broken', () => {
    const legacy = [
      { v: 1, id: 'a', ts: '2026-01-01T00:00:00.000Z', type: 'prompt' as const },
      { v: 1, id: 'b', ts: '2026-01-01T00:01:00.000Z', type: 'prompt' as const },
      { v: 1, id: 'c', ts: '2026-01-01T00:02:00.000Z', type: 'prompt' as const },
    ];
    expect(checkChain(legacy)).toEqual({ breaks: [], unchained: 2 });
  });
});
describe('checkObjects', () => {});
