import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  extractTranscriptEdits,
  importAntigravityIdeEdits,
  importAntigravityIdeTranscript,
  runImportAntigravityIde,
} from '../src/commands/importAntigravityIde.ts';
import { runInit } from '../src/commands/init.ts';
import { importedArtifactSourceIds } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { readLedgerRecords, unplacedSessions } from '../src/core/ledger.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/** A minimal IDE transcript: one prompt, one reply, one CODE_ACTION editing `editPath`. */
function makeTranscript(editPath: string): string {
  return (
    [
      JSON.stringify({
        type: 'USER_INPUT',
        step_index: 0,
        created_at: '2026-06-24T06:45:00Z',
        content: 'make a file',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-06-24T06:45:02Z',
        content: 'Done.',
      }),
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: 2,
        created_at: '2026-06-24T06:45:06Z',
        content: `Created file file:///${editPath} with requested content.`,
      }),
    ].join('\n') + '\n'
  );
}

describe('extractTranscriptEdits (CODE_ACTION file:// URIs)', () => {
  test('pulls the edited path + a stable sourceId from a CODE_ACTION line', () => {
    const raw =
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: 4,
        created_at: '2026-06-24T06:45:06Z',
        content: 'Created file file:///C:/proj/src/a.py with requested content.',
      }) + '\n';
    const edits = extractTranscriptEdits(raw, 'conv1');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe('C:/proj/src/a.py');
    expect(edits[0]!.timestamp).toBe('2026-06-24T06:45:06Z');
    expect(edits[0]!.sourceId).toBe('agy:edit:conv1:4:C:/proj/src/a.py');
  });

  test("skips the IDE's own .system_generated state (task logs, not student work)", () => {
    const raw =
      JSON.stringify({
        type: 'CODE_ACTION',
        step_index: 7,
        content:
          'Wrote file:///C:/Users/x/.gemini/antigravity-ide/brain/abc/.system_generated/tasks/task-3.log',
      }) + '\n';
    expect(extractTranscriptEdits(raw, 'conv1')).toEqual([]);
  });

  test('ignores non-CODE_ACTION lines and malformed JSON', () => {
    const raw = [
      '{ not json',
      JSON.stringify({ type: 'USER_INPUT', content: 'file:///C:/x.py' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'no file here' }),
    ].join('\n');
    expect(extractTranscriptEdits(raw, 'c')).toEqual([]);
  });
});

describe('importAntigravityIdeEdits', () => {
  test('records edited files as artifacts tagged antigravity-ide, idempotently', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const edits = [
        {
          path: `${dir}/src/a.ts`,
          diff: 'Created file …/src/a.ts with requested content.',
          sourceId: 'agy:edit:conv1:4:a',
          timestamp: '2026-06-24T06:45:06Z',
        },
      ];
      expect(importAntigravityIdeEdits(author, edits, { root: dir, batchId: 'b1' })).toBe(
        1,
      );
      // Re-importing the same edit adds nothing (dedup by sourceId).
      expect(importAntigravityIdeEdits(author, edits, { root: dir, batchId: 'b2' })).toBe(
        0,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('runImportAntigravityIde --auto routes by edited-file paths', () => {
  test('edits route to their nearest enclosing .showtail/ trail (idempotently)', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      // Edit sits deep under the project — no closer `.showtail/`, so it routes up
      // to the project root, exactly like any other tool's capture.
      const editPath = `${proj.replace(/\\/g, '/')}/deeply/nested/app.py`;
      const file = join(proj, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file });

      const paths = pathsForRoot(proj);
      const events = readAllEvents(paths);
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      expect(
        events.some((e) => e.type === 'ai_output' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      // The edited file was recorded as an artifact tagged antigravity-ide.
      expect(importedArtifactSourceIds(authorFor(paths)).size).toBeGreaterThan(0);

      // Idempotent: a second auto-run on the same transcript adds nothing.
      const before = readAllEvents(paths).length;
      await runImportAntigravityIde(undefined, { auto: true, file });
      expect(readAllEvents(paths).length).toBe(before);
    } finally {
      cleanup(proj);
    }
  });

  test('folderless/scratch work goes to the inbox, never the ~/.showtail catch-all', async () => {
    const bare = makeTempDir(); // no `.showtail/`, under tmpdir (within the ceiling)
    try {
      const editPath = `${bare.replace(/\\/g, '/')}/x/y.py`;
      const file = join(bare, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });

      // Crucially, no trail was invented anywhere on disk…
      expect(existsSync(join(bare, '.showtail'))).toBe(false);
      expect(existsSync(join(bare, 'x', '.showtail'))).toBe(false);
      // …and the conversation was parked in the inbox (the ledger) instead of being
      // dumped into a catch-all trail.
      const inbox = unplacedSessions().filter((s) => s.tool === 'antigravity-ide');
      expect(inbox).toHaveLength(1);
      const kinds = readLedgerRecords(inbox[0]!.id).map((r) => r.kind);
      expect(kinds).toContain('prompt');
      expect(kinds).toContain('ai_output');
      expect(kinds).toContain('edit');
    } finally {
      cleanup(bare);
    }
  });

  test('re-running --auto on a folderless conversation adds nothing (idempotent inbox)', async () => {
    const bare = makeTempDir();
    try {
      const editPath = `${bare.replace(/\\/g, '/')}/x/y.py`;
      const file = join(bare, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });
      const inbox1 = unplacedSessions().filter((s) => s.tool === 'antigravity-ide');
      expect(inbox1).toHaveLength(1);
      const before = readLedgerRecords(inbox1[0]!.id).length;

      await runImportAntigravityIde(undefined, { auto: true, file, cwd: bare });
      const inbox2 = unplacedSessions().filter((s) => s.tool === 'antigravity-ide');
      expect(inbox2).toHaveLength(1); // still one session (keyed by conversation id)
      expect(readLedgerRecords(inbox2[0]!.id).length).toBe(before); // no dup records
    } finally {
      cleanup(bare);
    }
  });

  test('a conversation routed into a real project trail does NOT also hit the inbox', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      const editPath = `${proj.replace(/\\/g, '/')}/app.py`;
      const file = join(proj, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file });

      expect(unplacedSessions().filter((s) => s.tool === 'antigravity-ide')).toHaveLength(
        0,
      );
    } finally {
      cleanup(proj);
    }
  });
});

describe('importAntigravityIdeTranscript still imports the conversation', () => {
  test('prompts + replies land tagged antigravity-ide', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const author = authorFor(pathsForRoot(dir));
      const res = await importAntigravityIdeTranscript(
        author,
        {
          sessionId: 'c1',
          messages: [
            { role: 'user', text: 'hi', sourceId: 'agy:user:c1:0' },
            { role: 'assistant', text: 'hello', sourceId: 'agy:asst:c1:1' },
          ],
        },
        { withResponses: true },
      );
      expect(res.prompts).toBe(1);
      expect(res.responses).toBe(1);
      expect(res.edits).toBe(0); // edits come from the raw-transcript scan, not here
      const events = readAllEvents(pathsForRoot(dir));
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
