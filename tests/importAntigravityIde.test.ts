import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  extractTranscriptEdits,
  importAntigravityIdeEdits,
  importAntigravityIdeTranscript,
  runImportAntigravityIde,
} from '../src/commands/importAntigravityIde.ts';
import { runInit } from '../src/commands/init.ts';
import { antigravityIdeScratchDir } from '../src/core/antigravityIdeTranscript.ts';
import { importedArtifactSourceIds } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
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
  test('edits under a tracked .showtail/ project land in that project', async () => {
    const proj = makeTempDir();
    try {
      await runInit({ cwd: proj });
      const editPath = `${proj.replace(/\\/g, '/')}/src/a.py`;
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
    } finally {
      cleanup(proj);
    }
  });

  test('edits under no project go to the scratch trail (created on first use)', async () => {
    const prevGemini = process.env.GEMINI_HOME;
    const gemini = mkdtempSync(join(tmpdir(), 'showtail-test-gemini-'));
    process.env.GEMINI_HOME = gemini;
    try {
      const scratch = antigravityIdeScratchDir();
      // An edit inside the scratch sandbox, under no .showtail/ project.
      const editPath = `${scratch.replace(/\\/g, '/')}/hello/index.html`;
      const file = join(gemini, 'transcript.jsonl');
      writeFileSync(file, makeTranscript(editPath), 'utf8');

      await runImportAntigravityIde(undefined, { auto: true, file });

      const paths = pathsForRoot(scratch); // .showtail/ now exists at the scratch root
      const events = readAllEvents(paths);
      expect(
        events.some((e) => e.type === 'prompt' && e.tool === 'antigravity-ide'),
      ).toBe(true);
      expect(importedArtifactSourceIds(authorFor(paths)).size).toBeGreaterThan(0);

      // Idempotent: a second auto-run on the same transcript adds nothing.
      const before = readAllEvents(paths).length;
      await runImportAntigravityIde(undefined, { auto: true, file });
      expect(readAllEvents(paths).length).toBe(before);
    } finally {
      cleanup(gemini);
      if (prevGemini === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = prevGemini;
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
