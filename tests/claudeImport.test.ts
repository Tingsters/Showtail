import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript, summarizeTranscripts } from '../src/core/claudeCode.ts';
import { readAllEvents } from '../src/core/events.ts';
import { runInit } from '../src/commands/init.ts';
import { parseSelection, runImportClaudeCode } from '../src/commands/importClaude.ts';
import { runImportUndo } from '../src/commands/import.ts';
import { claudeProjectsDir } from '../src/core/claudeCode.ts';
import { mkdirSync } from 'node:fs';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/**
 * Build a realistic Claude Code transcript (one JSON object per line) mixing the
 * lines we keep with the noise we must drop. `dir` is the project root so the
 * Edit's file_path is inside the repo.
 */
function makeTranscript(dir: string): string {
  const fooPath = join(dir, 'src', 'foo.ts');
  const lines: unknown[] = [
    // 1. A genuine typed prompt.
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-10T10:00:00.000Z',
      promptSource: 'typed',
      sessionId: 'sess-1',
      cwd: dir,
      message: { role: 'user', content: 'Add a foo function to the project.' },
    },
    // 2. An assistant turn: text reply + an Edit tool_use.
    {
      type: 'assistant',
      uuid: 'u2',
      timestamp: '2026-06-10T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: "Sure — I'll add foo." },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: fooPath } },
        ],
      },
    },
    // 3. Subagent traffic — dropped.
    {
      type: 'user',
      uuid: 'u3',
      isSidechain: true,
      promptSource: 'typed',
      message: { role: 'user', content: 'sidechain prompt that must not appear' },
    },
    // 4. A tool_result user line (array content) — dropped.
    {
      type: 'user',
      uuid: 'u4',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      },
    },
    // 5. A slash-command/meta wrapper user line — dropped.
    {
      type: 'user',
      uuid: 'u5',
      isMeta: true,
      message: {
        role: 'user',
        content: '<local-command-caveat>Caveat: generated locally</local-command-caveat>',
      },
    },
    // 6. A synthetic assistant line (e.g. an error notice) — dropped.
    {
      type: 'assistant',
      uuid: 'u6',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Please run /login' }],
      },
    },
    // 7. An edit to an internal file — dropped (not the student's project work).
    {
      type: 'assistant',
      uuid: 'u7',
      timestamp: '2026-06-10T10:02:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'Write',
            input: { file_path: join(dir, '.showtail', 'state.json') },
          },
        ],
      },
    },
    // 8. A second genuine typed prompt.
    {
      type: 'user',
      uuid: 'u8',
      timestamp: '2026-06-10T10:03:00.000Z',
      promptSource: 'typed',
      message: { role: 'user', content: 'Now add a test for foo.' },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseClaudeTranscript', () => {
  test('keeps typed prompts, assistant text and repo edits; drops the noise', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeTranscript(dir), dir);
      const roles = messages.map((m) => m.role);

      expect(roles.filter((r) => r === 'user').length).toBe(2);
      expect(roles.filter((r) => r === 'assistant').length).toBe(1);
      expect(roles.filter((r) => r === 'edit').length).toBe(1);

      // No sidechain / tool_result / meta / synthetic content leaked through.
      const texts = messages.map((m) => m.text).join('\n');
      expect(texts).not.toContain('sidechain prompt');
      expect(texts).not.toContain('local-command-caveat');
      expect(texts).not.toContain('Please run /login');

      // The kept edit points at the repo file, not the internal one.
      const edit = messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['src/foo.ts']);
      expect(texts).not.toContain('state.json');

      // Timestamps are preserved for back-dating.
      expect(messages[0]!.timestamp).toBe('2026-06-10T10:00:00.000Z');
    } finally {
      cleanup(dir);
    }
  });

  test('keeps queued and suggestion_accepted prompts; drops system and sdk', () => {
    const dir = makeTempDir();
    try {
      const line = (uuid: string, source: string, content: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          promptSource: source,
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content },
        });
      const transcript = [
        line('q', 'queued', 'queued user prompt'),
        line('s', 'suggestion_accepted', 'accepted suggestion prompt'),
        line('y', 'system', 'system injected prompt'),
        line('k', 'sdk', 'sdk programmatic prompt'),
        // No promptSource at all (older transcripts) — still a real prompt.
        JSON.stringify({
          type: 'user',
          uuid: 'o',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'legacy prompt without a source' },
        }),
      ].join('\n');

      const { messages } = parseClaudeTranscript(transcript, dir);
      const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.text);

      // Genuine interactive sources (and a missing source) are kept...
      expect(userTexts).toContain('queued user prompt');
      expect(userTexts).toContain('accepted suggestion prompt');
      expect(userTexts).toContain('legacy prompt without a source');
      // ...tooling/programmatic sources are dropped (they must not open a turn).
      expect(userTexts).not.toContain('system injected prompt');
      expect(userTexts).not.toContain('sdk programmatic prompt');
      expect(userTexts.length).toBe(3);
    } finally {
      cleanup(dir);
    }
  });
});

describe('parseSelection', () => {
  test('parses single, comma, space, and range inputs to zero-based indices', () => {
    expect(parseSelection('1', 3)).toEqual([0]);
    expect(parseSelection('1,3', 3)).toEqual([0, 2]);
    expect(parseSelection('1 3', 3)).toEqual([0, 2]);
    expect(parseSelection('1-3', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('2-1', 3)).toBeNull(); // descending range is invalid
  });

  test('de-duplicates while preserving first-seen order', () => {
    expect(parseSelection('3,1,3,1', 3)).toEqual([2, 0]);
  });

  test('rejects out-of-range, zero, and non-numeric tokens', () => {
    expect(parseSelection('0', 3)).toBeNull();
    expect(parseSelection('4', 3)).toBeNull();
    expect(parseSelection('1,x', 3)).toBeNull();
    expect(parseSelection('', 3)).toBeNull();
  });
});

describe('summarizeTranscripts', () => {
  test('reports counts, span, first/last prompt, and import state', async () => {
    const config = makeTempDir();
    const dir = makeTempDir();
    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      // Drop a transcript where Claude Code would store it (matched by cwd).
      const projDir = join(claudeProjectsDir(), 'encoded-project');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'sess-1.jsonl'), makeTranscript(dir), 'utf8');

      let summaries = summarizeTranscripts(author);
      expect(summaries.length).toBe(1);
      const s = summaries[0]!;
      expect(s.info.sessionId).toBe('sess-1');
      expect(s.promptCount).toBe(2);
      expect(s.editCount).toBe(1);
      expect(s.firstPrompt).toBe('Add a foo function to the project.');
      expect(s.lastPrompt).toBe('Now add a test for foo.');
      expect(s.first).toBe('2026-06-10T10:00:00.000Z');
      expect(s.last).toBe('2026-06-10T10:03:00.000Z');
      expect(s.importState).toBe('none');

      // After importing the whole session, it reads as fully imported.
      await runImportClaudeCode(undefined, {
        file: join(projDir, 'sess-1.jsonl'),
        withResponses: true,
        cwd: dir,
      });
      summaries = summarizeTranscripts(author);
      expect(summaries[0]!.importState).toBe('full');
    } finally {
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
      cleanup(config);
      cleanup(dir);
    }
  });
});

describe('claude-code import (end to end)', () => {
  test('imports prompts/responses/edits back-dated; dedupes; undo removes the batch', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeTranscript(dir), 'utf8');

      await runImportClaudeCode(undefined, {
        file: fixture,
        withResponses: true,
        cwd: dir,
      });

      const cc = () => readAllEvents(paths).filter((e) => e.tool === 'claude-code');
      const imported = cc();
      expect(imported.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(imported.filter((e) => e.type === 'ai_output').length).toBe(1);
      expect(imported.filter((e) => e.type === 'artifact').length).toBe(1);
      expect(imported.every((e) => e.batchId)).toBe(true);
      expect(imported.every((e) => e.tags?.includes('imported'))).toBe(true);
      expect(imported.every((e) => e.timestamp.startsWith('2026-06-10'))).toBe(true);

      const count = imported.length;

      // Re-importing the same transcript adds nothing (deduped by sourceId).
      await runImportClaudeCode(undefined, {
        file: fixture,
        withResponses: true,
        cwd: dir,
      });
      expect(cc().length).toBe(count);

      // Undo removes the whole batch.
      await runImportUndo({ cwd: dir });
      expect(cc().length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('without --with-responses, only prompts and edits are imported', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeTranscript(dir), 'utf8');

      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });

      const cc = readAllEvents(paths).filter((e) => e.tool === 'claude-code');
      expect(cc.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(cc.filter((e) => e.type === 'ai_output').length).toBe(0);
      expect(cc.filter((e) => e.type === 'artifact').length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });
});
