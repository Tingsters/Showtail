import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { claudeProjectsDir } from '../src/core/claudeCode.ts';
import { mkdirSync } from 'node:fs';
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
  test('drops harness-injected user envelopes (task-notification, system-reminder)', () => {
    const dir = makeTempDir();
    try {
      const line = (uuid: string, content: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          promptSource: 'typed',
          timestamp: '2026-06-10T10:00:00.000Z',
          cwd: dir,
          message: { role: 'user', content },
        });
      const transcript =
        [
          // A background-subagent result, injected as a user turn (often many KB).
          line(
            'n1',
            '<task-notification>\n<task-id>abc</task-id>\nAgent finished. Long result…',
          ),
          // Injected context, also a user-role message.
          line(
            'n2',
            '<system-reminder>Background context, not user input.</system-reminder>',
          ),
          // A genuine prompt that merely *mentions* the tag later — must be kept.
          line('n3', 'Why did the <task-notification> block show up as a prompt before?'),
        ].join('\n') + '\n';
      const { messages } = parseClaudeTranscript(transcript, dir);
      const users = messages.filter((m) => m.role === 'user');
      expect(users.length).toBe(1); // only the real question survives
      expect(users[0]!.text).toContain('Why did the');
      const all = messages.map((m) => m.text).join('\n');
      expect(all).not.toContain('<task-id>');
      expect(all).not.toContain('Background context');
    } finally {
      cleanup(dir);
    }
  });
  test('drops the context-compaction summary (isCompactSummary), keeps real prompts', () => {
    const dir = makeTempDir();
    try {
      const transcript =
        [
          JSON.stringify({
            type: 'user',
            uuid: 'c1',
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
            timestamp: '2026-06-10T10:00:00.000Z',
            cwd: dir,
            // Note: text is NOT tag-wrapped — only the structural flag identifies it.
            message: {
              role: 'user',
              content:
                'This session is being continued from a previous conversation that ran out of context.\n\nSummary: …',
            },
          }),
          JSON.stringify({
            type: 'user',
            uuid: 'c2',
            promptSource: 'typed',
            timestamp: '2026-06-10T10:01:00.000Z',
            cwd: dir,
            message: { role: 'user', content: 'now add tests' },
          }),
        ].join('\n') + '\n';
      const { messages } = parseClaudeTranscript(transcript, dir);
      const users = messages.filter((m) => m.role === 'user');
      expect(users.length).toBe(1);
      expect(users[0]!.text).toBe('now add tests');
      expect(messages.map((m) => m.text).join('\n')).not.toContain(
        'This session is being continued',
      );
    } finally {
      cleanup(dir);
    }
  });
  test('keeps queued, accepted suggestions and SDK submissions; drops system context', () => {
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
      // SDK is also the transport for a user's headless CLI submission.
      expect(userTexts).toContain('sdk programmatic prompt');
      // Injected system context still must not open a turn.
      expect(userTexts).not.toContain('system injected prompt');
      expect(userTexts.length).toBe(4);
    } finally {
      cleanup(dir);
    }
  });
});
describe('parseSelection', () => {});
describe('summarizeTranscripts', () => {});
describe('claude-code import (end to end)', () => {});
