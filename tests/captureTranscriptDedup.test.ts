import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { captureTranscriptToLedger } from '../src/commands/hook.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerRecords,
  type LedgerRecord,
} from '../src/core/ledger.ts';
import type { HookTranscript } from '../src/plugins/types.ts';
import { cleanup, makeTempDir } from './helpers.ts';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

describe('captureTranscriptToLedger: prompt back-fill is race-safe', () => {
  // A prompt has two writers: the live `user-prompt` hook (no sourceId) and this
  // Stop-time reconcile's back-fill. For a turn the live hook fires first, but in
  // a separate process, so its append can land AFTER the reconcile snapshots the
  // records. The reconcile must re-read fresh before back-filling, or it records
  // the same prompt twice (the Codex duplicate-prompt bug).
  test('a live prompt that lands after the stale snapshot is matched, not duplicated', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({ tool: 'codex', nativeSessionId: 'cdx-race' });

      // The live hook already recorded this prompt (no sourceId), as it always does
      // before the Stop for the same turn.
      const ts = new Date().toISOString();
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Implement the plan.',
        ts,
      });

      // Simulate the race: the reconcile's FIRST read (its snapshot) is stale —
      // empty, because the live append hadn't landed yet — and only the re-read
      // before back-filling sees the live record on disk.
      let reads = 0;
      const staleThenFresh = (id: string): LedgerRecord[] =>
        reads++ === 0 ? [] : readLedgerRecords(id);

      const transcript: HookTranscript = {
        sessionId: 'cdx-race',
        messages: [
          {
            role: 'user',
            text: 'Implement the plan.',
            sourceId: 'codex:user:cdx-race:1',
            timestamp: ts,
          },
        ],
      };

      captureTranscriptToLedger(session, transcript, 'codex', [], staleThenFresh);

      const prompts = readLedgerRecords(session.id).filter((r) => r.kind === 'prompt');
      // One record — the live one was matched on the re-read, not back-filled again.
      expect(prompts.length).toBe(1);
      expect(prompts[0]!.sourceId).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });

  // A genuinely-missed prompt (the live hook never logged it — e.g. a plan-mode
  // turn) must still be back-filled, so the re-read doesn't suppress real captures.
  test('a prompt the live hook never captured is still back-filled', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({ tool: 'codex', nativeSessionId: 'cdx-fill' });

      const transcript: HookTranscript = {
        sessionId: 'cdx-fill',
        messages: [
          {
            role: 'user',
            text: 'plan-mode only prompt',
            sourceId: 'codex:user:cdx-fill:1',
            timestamp: new Date().toISOString(),
          },
        ],
      };

      captureTranscriptToLedger(session, transcript, 'codex');

      const prompts = readLedgerRecords(session.id).filter((r) => r.kind === 'prompt');
      expect(prompts.length).toBe(1);
      expect(prompts[0]!.sourceId).toBe('codex:user:cdx-fill:1');
    } finally {
      cleanup(home);
    }
  });
});
