import { describe, expect, test } from 'bun:test';
import {
  extractTranscriptEdits,
  importAntigravityIdeEdits,
  importAntigravityIdeTranscript,
} from '../src/commands/importAntigravityIde.ts';
import { runInit } from '../src/commands/init.ts';
import { readAllEvents } from '../src/core/events.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

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
