import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { readAllEvents } from '../src/core/events.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { runImportUndo } from '../src/commands/import.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

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
      await runImportClaudeCode(undefined, { file: fixture, withResponses: true, cwd: dir });
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
