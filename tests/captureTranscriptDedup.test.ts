import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { captureTranscriptToLedger } from '../src/core/ledgerCapture.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerRecords,
  readLedgerSession,
  setLedgerTurn,
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

      captureTranscriptToLedger(session, transcript, 'codex', [], {
        readRecords: staleThenFresh,
      });

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

  test('structured backlog events are not attached to the current live turn', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'backlog',
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'Current prompt',
      });
      const transcript: HookTranscript = {
        sessionId: 'backlog',
        messages: [
          {
            role: 'user',
            text: 'Old prompt',
            sourceId: 'old-user',
            timestamp: '2020-01-01T00:00:00Z',
          },
          {
            role: 'assistant',
            text: 'Old answer',
            sourceId: 'old-answer',
            timestamp: '2020-01-01T00:00:01Z',
          },
          {
            role: 'user',
            text: 'Current prompt',
            sourceId: 'new-user',
            timestamp: new Date().toISOString(),
          },
          {
            role: 'assistant',
            text: 'Current answer',
            sourceId: 'new-answer',
            timestamp: new Date().toISOString(),
          },
        ],
        events: [
          { sequence: 0, type: 'user_text', sourceId: 'old-user', text: 'Old prompt' },
          {
            sequence: 1,
            type: 'assistant_text',
            sourceId: 'old-answer',
            text: 'Old answer',
          },
          {
            sequence: 2,
            type: 'user_text',
            sourceId: 'new-user',
            text: 'Current prompt',
          },
          {
            sequence: 3,
            type: 'assistant_text',
            sourceId: 'new-answer',
            text: 'Current answer',
          },
        ],
      };

      captureTranscriptToLedger(session, transcript, 'claude-code');

      const raw = readLedgerRecords(session.id)
        .filter((record) => record.kind === 'conversation_event')
        .map((record) => record.conversationEvent?.text);
      expect(raw).toEqual(['Current prompt', 'Current answer']);
    } finally {
      cleanup(home);
    }
  });

  test('a resume cutoff keeps recorded context but excludes unseen off-period turns', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const created = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'resume-window',
      });
      const cutoffMs = Date.now() + 60_000;
      const oldTime = new Date(cutoffMs - 120_000).toISOString();
      const disabledTime = new Date(cutoffMs - 1_000).toISOString();
      const after = (offsetMs: number) => new Date(cutoffMs + offsetMs).toISOString();
      const oldPrompt = appendLedgerRecord(created.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Prompt captured before disconnect',
        sourceId: 'old-user',
        ts: oldTime,
      });
      setLedgerTurn(created.id, oldPrompt.id);
      const session = readLedgerSession(created.id)!;
      const cutoff = new Date(cutoffMs).toISOString();
      const transcript: HookTranscript = {
        sessionId: 'resume-window',
        messages: [
          {
            role: 'user',
            text: 'Prompt captured before disconnect',
            sourceId: 'old-user',
            timestamp: oldTime,
          },
          {
            role: 'assistant',
            text: 'A post-resume child can use recorded context.',
            sourceId: 'context-child',
            timestamp: after(1_000),
          },
          {
            role: 'user',
            text: 'Unseen prompt while capture was off',
            sourceId: 'disabled-user',
            timestamp: disabledTime,
          },
          {
            role: 'assistant',
            text: 'Must not cross the disabled prompt boundary.',
            sourceId: 'disabled-child',
            timestamp: after(2_000),
          },
          {
            role: 'edit',
            text: 'disabled child edit',
            sourceId: 'disabled-edit',
            timestamp: after(3_000),
            edits: [{ file: 'src/disabled.ts', diff: '+ disabled' }],
          },
          {
            role: 'user',
            text: 'Timestamp-less recovered prompt',
            sourceId: 'missing-time-user',
          },
          {
            role: 'assistant',
            text: 'Timestamp-less parent must fail closed.',
            sourceId: 'missing-time-child',
            timestamp: after(4_000),
          },
          {
            role: 'user',
            text: 'Prompt after reconnect',
            sourceId: 'resumed-user',
            timestamp: after(5_000),
          },
          {
            role: 'assistant',
            text: 'Captured after reconnect.',
            sourceId: 'resumed-child',
            timestamp: after(6_000),
          },
          {
            role: 'plan',
            text: 'Transcript plan after reconnect',
            sourceId: 'resumed-plan',
            timestamp: after(7_000),
          },
        ],
        events: [
          {
            sequence: 0,
            type: 'user_text',
            sourceId: 'old-user',
            text: 'Prompt captured before disconnect',
            timestamp: oldTime,
          },
          {
            sequence: 1,
            type: 'assistant_text',
            sourceId: 'context-event',
            text: 'Eligible structured child',
            timestamp: after(1_000),
          },
          {
            sequence: 2,
            type: 'user_text',
            sourceId: 'disabled-user',
            text: 'Unseen prompt while capture was off',
            timestamp: disabledTime,
          },
          {
            sequence: 3,
            type: 'assistant_text',
            sourceId: 'disabled-event',
            text: 'Ineligible structured child',
            timestamp: after(2_000),
          },
          {
            sequence: 4,
            type: 'user_text',
            sourceId: 'resumed-user',
            text: 'Prompt after reconnect',
            timestamp: after(5_000),
          },
          {
            sequence: 5,
            type: 'assistant_text',
            sourceId: 'resumed-event',
            text: 'Eligible resumed structured child',
            timestamp: after(6_000),
          },
        ],
      };

      captureTranscriptToLedger(
        session,
        transcript,
        'codex',
        [
          {
            absPath: 'plan.md',
            content: 'Plan file content written while capture was stopped',
            sourceId: 'undated-plan-file',
            nativeSessionId: 'resume-window',
          },
        ],
        { automaticCaptureSince: cutoff },
      );

      const records = readLedgerRecords(session.id);
      const sources = records.map((record) => record.sourceId);
      expect(sources).toContain('context-child');
      expect(sources).toContain('resumed-user');
      expect(sources).toContain('resumed-child');
      expect(sources).not.toContain('disabled-user');
      expect(sources).not.toContain('disabled-child');
      expect(sources).not.toContain('disabled-edit#src/disabled.ts');
      expect(sources).not.toContain('missing-time-user');
      expect(sources).not.toContain('missing-time-child');

      const structuredTexts = records
        .filter((record) => record.kind === 'conversation_event')
        .map((record) => record.conversationEvent?.text);
      expect(structuredTexts).toEqual([
        'Eligible structured child',
        'Prompt after reconnect',
        'Eligible resumed structured child',
      ]);
      const plan = records.find((record) => record.sourceId === 'resumed-plan');
      expect(plan?.planFileContent).toBeUndefined();
      expect(plan?.planFileSourceId).toBeUndefined();
      expect(readLedgerSession(session.id)?.currentTurnKey).toBe(
        records.find((record) => record.sourceId === 'resumed-user')?.id,
      );
    } finally {
      cleanup(home);
    }
  });

  test('a skipped user boundary clears stale persisted turn linkage', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const created = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'stale-turn',
      });
      const cutoffMs = Date.now() + 60_000;
      const cutoff = new Date(cutoffMs).toISOString();
      const oldPrompt = appendLedgerRecord(created.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Old prompt',
        sourceId: 'stale-old-user',
      });
      setLedgerTurn(created.id, oldPrompt.id);

      captureTranscriptToLedger(
        readLedgerSession(created.id)!,
        {
          sessionId: 'stale-turn',
          messages: [
            {
              role: 'user',
              text: 'Old prompt',
              sourceId: 'stale-old-user',
              timestamp: new Date(cutoffMs - 120_000).toISOString(),
            },
            {
              role: 'user',
              text: 'Unseen disabled prompt',
              sourceId: 'stale-disabled-user',
              timestamp: new Date(cutoffMs - 1_000).toISOString(),
            },
            {
              role: 'edit',
              text: 'Later child edit',
              sourceId: 'stale-later-edit',
              timestamp: new Date(cutoffMs + 1_000).toISOString(),
              edits: [{ file: 'src/later.ts', diff: '+ later' }],
            },
          ],
        },
        'codex',
        [],
        { automaticCaptureSince: cutoff },
      );

      expect(readLedgerSession(created.id)?.currentTurnKey).toBeUndefined();
      expect(
        readLedgerRecords(created.id).some(
          (record) => record.sourceId === 'stale-later-edit#src/later.ts',
        ),
      ).toBe(false);
    } finally {
      cleanup(home);
    }
  });

  test('a lagging transcript does not move the current turn back from a newer live prompt', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const created = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'lagging-turn',
      });
      const started = Date.parse(created.startedAt);
      const olderTime = new Date(started + 1_000).toISOString();
      const newerTime = new Date(started + 2_000).toISOString();
      const olderPrompt = appendLedgerRecord(created.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Older prompt already in the transcript',
        sourceId: 'lagging-old-user',
        ts: olderTime,
      });
      const newerPrompt = appendLedgerRecord(created.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Newer live prompt not flushed to the transcript yet',
        ts: newerTime,
      });
      setLedgerTurn(created.id, newerPrompt.id);

      captureTranscriptToLedger(
        readLedgerSession(created.id)!,
        {
          sessionId: 'lagging-turn',
          messages: [
            {
              role: 'user',
              text: 'Older prompt already in the transcript',
              sourceId: 'lagging-old-user',
              timestamp: olderTime,
            },
            {
              role: 'assistant',
              text: 'Late transcript tail for the older turn.',
              sourceId: 'lagging-old-answer',
              timestamp: new Date(started + 1_500).toISOString(),
            },
          ],
        },
        'codex',
        [],
        { automaticCaptureSince: created.startedAt },
      );

      expect(readLedgerSession(created.id)?.currentTurnKey).toBe(newerPrompt.id);
      expect(
        readLedgerRecords(created.id).find(
          (record) => record.sourceId === 'lagging-old-answer',
        )?.turnKey,
      ).toBe(olderPrompt.id);
    } finally {
      cleanup(home);
    }
  });

  test('a transcript that passes the current prompt still advances the turn', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const created = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'advancing-turn',
      });
      const started = Date.parse(created.startedAt);
      const currentTime = new Date(started + 1_000).toISOString();
      const nextTime = new Date(started + 2_000).toISOString();
      const currentPrompt = appendLedgerRecord(created.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'Current live prompt',
        sourceId: 'advance-current-user',
        ts: currentTime,
      });
      setLedgerTurn(created.id, currentPrompt.id);

      captureTranscriptToLedger(
        readLedgerSession(created.id)!,
        {
          sessionId: 'advancing-turn',
          messages: [
            {
              role: 'user',
              text: 'Current live prompt',
              sourceId: 'advance-current-user',
              timestamp: currentTime,
            },
            {
              role: 'user',
              text: 'Prompt recovered after the current turn',
              sourceId: 'advance-next-user',
              timestamp: nextTime,
            },
          ],
        },
        'codex',
        [],
        { automaticCaptureSince: created.startedAt },
      );

      const nextPrompt = readLedgerRecords(created.id).find(
        (record) => record.sourceId === 'advance-next-user',
      );
      expect(nextPrompt?.kind).toBe('prompt');
      expect(readLedgerSession(created.id)?.currentTurnKey).toBe(nextPrompt?.id);
    } finally {
      cleanup(home);
    }
  });

  test('a continuation predicate stops a transcript replay before later writes', () => {
    const home = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'revoked-mid-transcript',
      });
      const transcript: HookTranscript = {
        sessionId: 'revoked-mid-transcript',
        messages: [
          {
            role: 'user',
            text: 'first allowed prompt',
            sourceId: 'mid-user',
          },
          {
            role: 'assistant',
            text: 'must not be appended after revocation',
            sourceId: 'mid-answer',
          },
          {
            role: 'decision',
            text: 'nor this decision',
            sourceId: 'mid-decision',
          },
        ],
      };

      const completed = captureTranscriptToLedger(
        session,
        transcript,
        'claude-code',
        [],
        {
          backfill: true,
          continueCapture: () =>
            readLedgerRecords(session.id).filter((record) => record.sourceId).length ===
            0,
        },
      );

      expect(completed).toBe(false);
      expect(readLedgerRecords(session.id).map((record) => record.sourceId)).toEqual([
        'mid-user',
      ]);
      expect(readLedgerSession(session.id)?.currentTurnKey).toBeUndefined();

      expect(
        captureTranscriptToLedger(session, transcript, 'claude-code', [], {
          backfill: true,
        }),
      ).toBe(true);
      const records = readLedgerRecords(session.id);
      expect(records.map((record) => record.sourceId)).toEqual([
        'mid-user',
        'mid-answer',
        'mid-decision',
      ]);
      expect(readLedgerSession(session.id)?.currentTurnKey).toBe(records[0]!.id);
    } finally {
      cleanup(home);
    }
  });
});
