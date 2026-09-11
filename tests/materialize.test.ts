import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllConversationEventsWithSession } from '../src/core/conversationEvents.ts';
import { readAllEvents } from '../src/core/events.ts';
import { readJournal } from '../src/core/journal.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  ledgerRecordProjectionSourceId,
  readLedgerRecords,
} from '../src/core/ledger.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import { PLAN_APPROVED_TAG } from '../src/core/plans.ts';
import { pathsForRoot, readSessions, readState } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

describe('materialize: projecting every record kind', () => {
  test('revocation before native-session creation leaves no projected session or state', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const initialState = readState(paths);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'revoked-before-repo-session',
        cwd: dir,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'must not create a projected session',
      });
      let checks = 0;

      const interrupted = await materializeLedgerSession(session, author, {
        continueCapture: () => {
          checks += 1;
          return checks < 2;
        },
      });

      expect(checks).toBe(2);
      expect(interrupted.completed).toBe(false);
      expect(interrupted.projected).toBe(0);
      expect(readSessions(author)).toEqual([]);
      expect(readState(paths)).toEqual(initialState);
      expect(readAllEvents(paths)).toEqual([]);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('projects prompt, ai_output, decision, plan, diff-edit and snapshot-edit, idempotently', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's1',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'do the work',
      });
      appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'claude-code',
        text: 'sure, here it is',
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'decision',
        tool: 'claude-code',
        text: 'chose option A',
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'claude-code',
        text: 'the approved plan',
        approved: true,
        turnKey: p.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'a.ts'),
        diff: '+ const a = 1;',
        turnKey: p.id,
      });
      // A no-diff edit whose file is present at the root → live snapshot path.
      writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'b.ts'),
        turnKey: p.id,
      });

      const r1 = await materializeLedgerSession(session, author);
      expect(r1.projected).toBe(6);

      const events = readAllEvents(paths);
      const prompt = events.find((e) => e.type === 'prompt')!;
      const ai = events.find((e) => e.type === 'ai_output')!;
      const decision = events.find((e) => e.type === 'decision')!;
      const plan = events.find((e) => e.type === 'plan')!;
      expect(prompt.text).toBe('do the work');
      expect(ai.text).toBe('sure, here it is');
      // Replies/decisions/plans re-link to their prompt's turn.
      expect(ai.turnId).toBe(prompt.id);
      expect(decision.turnId).toBe(prompt.id);
      expect(plan.turnId).toBe(prompt.id);
      expect(plan.tags).toContain(PLAN_APPROVED_TAG);

      const arts = readAllArtifacts(paths);
      expect(arts.some((a) => a.path === 'a.ts' && a.diffHash)).toBe(true);
      expect(arts.some((a) => a.path === 'b.ts' && a.sha256)).toBe(true);

      // Re-materialize: every record dedups, nothing new is projected.
      const r2 = await materializeLedgerSession(session, author);
      expect(r2.projected).toBe(0);
      expect(readAllEvents(paths).filter((e) => e.type === 'ai_output').length).toBe(1);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a plan with an on-disk plan file links the materialized file, not the text', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'antigravity-cli',
        nativeSessionId: 'agy1',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'antigravity-cli',
        text: 'plan it',
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'antigravity-cli',
        text: 'transcript plan summary',
        planFileContent: 'FULL PLAN from disk',
        planFileSourceId: 'agy-plan:agy1',
        turnKey: p.id,
      });
      await materializeLedgerSession(session, author);

      const plan = readAllEvents(paths).find((e) => e.type === 'plan')!;
      expect(plan.planPath).toBe('plans/agy-plan_agy1.md');
      const file = join(dir, '.showtail', plan.planPath!);
      expect(readFileSync(file, 'utf8')).toContain('FULL PLAN from disk');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a revised plan projects with the revised tag', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's2',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'plan it',
      });
      appendLedgerRecord(session.id, {
        kind: 'plan',
        tool: 'claude-code',
        text: 'a rejected plan',
        approved: false,
        turnKey: p.id,
      });
      await materializeLedgerSession(session, author);
      const plan = readAllEvents(paths).find((e) => e.type === 'plan')!;
      expect(plan.tags?.length).toBeGreaterThan(0);
      expect(plan.tags).not.toContain(PLAN_APPROVED_TAG);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('a continuation predicate stops materialization before later record writes', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'revoked-mid-materialize',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'project this prompt only',
      });
      appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'claude-code',
        text: 'do not project this reply yet',
        turnKey: prompt.id,
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'later.ts'),
        diff: '+ export const later = true;',
        turnKey: prompt.id,
      });

      const interrupted = await materializeLedgerSession(session, author, {
        continueCapture: () => readAllEvents(paths).length === 0,
      });

      expect(interrupted.completed).toBe(false);
      expect(interrupted.projected).toBe(1);
      expect(readAllEvents(paths).map((event) => event.type)).toEqual(['prompt']);
      expect(readAllArtifacts(paths)).toHaveLength(0);

      const resumed = await materializeLedgerSession(session, author);
      expect(resumed.completed).toBe(true);
      expect(resumed.projected).toBe(2);
      expect(readAllEvents(paths).map((event) => event.type)).toEqual([
        'prompt',
        'ai_output',
      ]);
      expect(readAllArtifacts(paths).map((artifact) => artifact.path)).toEqual([
        'later.ts',
      ]);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('revocation during snapshot preparation does not create an artifact or stub', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'revoked-mid-snapshot',
        cwd: dir,
      });
      writeFileSync(join(dir, 'guarded.ts'), 'export const guarded = true;\n');
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'guarded.ts'),
      });
      let checks = 0;

      const interrupted = await materializeLedgerSession(session, author, {
        continueCapture: () => {
          checks += 1;
          return checks < 5;
        },
      });

      expect(checks).toBe(5);
      expect(interrupted.completed).toBe(false);
      expect(interrupted.projected).toBe(0);
      expect(interrupted.stubs).toBe(0);
      expect(readAllArtifacts(paths)).toHaveLength(0);

      const resumed = await materializeLedgerSession(session, author);
      expect(resumed.completed).toBe(true);
      expect(resumed.projected).toBe(1);
      expect(resumed.edits).toBe(1);
      expect(resumed.stubs).toBe(0);
      expect(readAllArtifacts(paths).map((artifact) => artifact.path)).toEqual([
        'guarded.ts',
      ]);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('replaces a projected partial response with its audited final revision', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'github-copilot',
        nativeSessionId: 'projected-stream-upgrade',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text: 'Explain the result.',
        sourceId: 'copilot:user:projected-stream-upgrade:request_1',
      });
      const partialReply = appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'Short partial.',
        turnKey: prompt.id,
        sourceId: 'copilot:asst:projected-stream-upgrade:request_1',
        transcriptFinal: false,
      });
      const partialStructured = appendLedgerRecord(session.id, {
        kind: 'conversation_event',
        tool: 'github-copilot',
        turnKey: prompt.id,
        sourceId: 'conversation:copilot:asst:projected-stream-upgrade:request_1',
        transcriptFinal: false,
        conversationEvent: {
          sequence: 1,
          type: 'assistant_text',
          sourceId: 'copilot:asst:projected-stream-upgrade:request_1',
          text: 'Short partial.',
        },
      });

      expect((await materializeLedgerSession(session, author)).projected).toBe(3);
      expect(readAllEvents(paths).find((event) => event.type === 'ai_output')?.text).toBe(
        'Short partial.',
      );

      const finalReply = appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'Complete final response.',
        turnKey: prompt.id,
        sourceId: partialReply.sourceId,
        supersedesRecordId: partialReply.id,
        transcriptFinal: true,
      });
      const finalStructured = appendLedgerRecord(session.id, {
        kind: 'conversation_event',
        tool: 'github-copilot',
        turnKey: prompt.id,
        sourceId: partialStructured.sourceId,
        supersedesRecordId: partialStructured.id,
        transcriptFinal: true,
        conversationEvent: {
          sequence: 1,
          type: 'assistant_text',
          sourceId: 'copilot:asst:projected-stream-upgrade:request_1',
          text: 'Complete final response.',
        },
      });

      const corrected = await materializeLedgerSession(session, author);
      expect(corrected.projected).toBe(2);
      const replies = readAllEvents(paths).filter((event) => event.type === 'ai_output');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        text: 'Complete final response.',
        sourceId: ledgerRecordProjectionSourceId(session.id, finalReply),
      });
      const structured = readAllConversationEventsWithSession(paths).filter(
        ({ event }) => event.type === 'assistant_text',
      );
      expect(structured).toHaveLength(1);
      expect(structured[0]?.event).toMatchObject({
        text: 'Complete final response.',
        sourceId: ledgerRecordProjectionSourceId(session.id, finalStructured),
      });
      const repairs = readJournal(author).filter(
        (entry) =>
          entry.kind === 'redaction' &&
          entry.redaction?.reason === 'repair' &&
          entry.redaction.labels.includes('capture-correction'),
      );
      expect(repairs).toHaveLength(1);
      expect(repairs[0]?.redaction?.entries).toBe(2);
      expect(readLedgerRecords(session.id)).toEqual(
        expect.arrayContaining([
          partialReply,
          partialStructured,
          finalReply,
          finalStructured,
        ]),
      );

      expect((await materializeLedgerSession(session, author)).projected).toBe(0);
      expect(
        readJournal(author).filter(
          (entry) =>
            entry.kind === 'redaction' &&
            entry.redaction?.reason === 'repair' &&
            entry.redaction.labels.includes('capture-correction'),
        ),
      ).toHaveLength(1);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('keeps one response revision visible when correction cleanup is interrupted', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = ensureLedgerSession({
        tool: 'github-copilot',
        nativeSessionId: 'interrupted-stream-upgrade',
        cwd: dir,
      });
      const prompt = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'github-copilot',
        text: 'Explain the result.',
        sourceId: 'copilot:user:interrupted-stream-upgrade:request_1',
      });
      const partial = appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'Short partial.',
        turnKey: prompt.id,
        sourceId: 'copilot:asst:interrupted-stream-upgrade:request_1',
        transcriptFinal: false,
      });
      expect((await materializeLedgerSession(session, author)).projected).toBe(2);

      const final = appendLedgerRecord(session.id, {
        kind: 'ai_output',
        tool: 'github-copilot',
        text: 'Complete final response.',
        turnKey: prompt.id,
        sourceId: partial.sourceId,
        supersedesRecordId: partial.id,
        transcriptFinal: true,
      });
      const finalSourceId = ledgerRecordProjectionSourceId(session.id, final);
      const interrupted = await materializeLedgerSession(session, author, {
        continueCapture: () =>
          !readAllEvents(paths).some((event) => event.sourceId === finalSourceId),
      });

      expect(interrupted).toMatchObject({ completed: false, projected: 1, replies: 1 });
      expect(
        readAllEvents(paths)
          .filter((event) => event.type === 'ai_output')
          .map((event) => event.text),
      ).toEqual(['Short partial.', 'Complete final response.']);
      expect(
        readJournal(author).filter(
          (entry) =>
            entry.kind === 'redaction' &&
            entry.redaction?.labels.includes('capture-correction'),
        ),
      ).toHaveLength(0);

      const resumed = await materializeLedgerSession(session, author);
      expect(resumed).toMatchObject({ completed: true, projected: 0 });
      expect(
        readAllEvents(paths)
          .filter((event) => event.type === 'ai_output')
          .map((event) => ({ text: event.text, sourceId: event.sourceId })),
      ).toEqual([{ text: 'Complete final response.', sourceId: finalSourceId }]);
      expect(
        readJournal(author).filter(
          (entry) =>
            entry.kind === 'redaction' &&
            entry.redaction?.labels.includes('capture-correction'),
        ),
      ).toHaveLength(1);

      expect((await materializeLedgerSession(session, author)).projected).toBe(0);
      expect(
        readJournal(author).filter(
          (entry) =>
            entry.kind === 'redaction' &&
            entry.redaction?.labels.includes('capture-correction'),
        ),
      ).toHaveLength(1);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
