import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { readAllEvents } from '../src/core/events.ts';
import { buildReportData, renderMarkdown } from '../src/core/report.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/**
 * A transcript where Claude pauses with `AskUserQuestion` (two questions in one
 * call: the first answered by picking an option, the second by typing a custom
 * answer), then the student's answers come back as a `tool_result` line.
 */
function makeDecisionTranscript(): string {
  const lines: unknown[] = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-10T10:00:00.000Z',
      promptSource: 'typed',
      sessionId: 'sess-1',
      message: { role: 'user', content: 'Build authentication for the app.' },
    },
    {
      type: 'assistant',
      uuid: 'u2',
      timestamp: '2026-06-10T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'Let me confirm a couple of things first.' },
          {
            type: 'tool_use',
            id: 'tq1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which auth approach?',
                  header: 'Auth',
                  multiSelect: false,
                  options: [
                    { label: 'Session cookies', description: 'Server sessions.' },
                    { label: 'JWT', description: 'Stateless tokens.' },
                    { label: 'OAuth only', description: 'Delegate to a provider.' },
                  ],
                },
                {
                  question: 'What should the auth function be named?',
                  header: 'Name',
                  multiSelect: false,
                  options: [
                    { label: 'authenticate', description: 'Verb.' },
                    { label: 'login', description: 'Short.' },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-06-10T10:02:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tq1',
            content:
              'Your questions have been answered: "Which auth approach?"="JWT" ' +
              'selected preview:\nstateless tokens, ' +
              '"What should the auth function be named?"="verifyUser". ' +
              'You can now continue with these answers in mind.',
          },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseClaudeTranscript — decisions', () => {
  test('pairs an AskUserQuestion with its answer; marks chosen + typed', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeDecisionTranscript(), dir);
      const decision = messages.find((m) => m.role === 'decision');
      expect(decision).toBeDefined();
      expect(decision!.sourceId).toBe('tq1');

      const text = decision!.text;
      // The question and all offered options are present.
      expect(text).toContain('Which auth approach?');
      expect(text).toContain('Session cookies');
      expect(text).toContain('OAuth only');
      // The picked option is marked; the others are not.
      expect(text).toContain('**JWT** ✅');
      expect(text).not.toContain('**Session cookies** ✅');
      // The second question was answered with free-typed text.
      expect(text).toContain('What should the auth function be named?');
      expect(text).toContain('**You typed:** verifyUser');

      // Structured data is resolved too.
      const q1 = decision!.questions![0]!;
      expect(q1.options.find((o) => o.label === 'JWT')!.chosen).toBe(true);
      expect(q1.custom).toBe(false);
      const q2 = decision!.questions![1]!;
      expect(q2.custom).toBe(true);
      expect(q2.answer).toBe('verifyUser');
    } finally {
      cleanup(dir);
    }
  });
});

describe('claude-code decision import', () => {
  test('imports decisions as decision events (even without responses) and dedupes', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeDecisionTranscript(), 'utf8');

      // No --with-responses: decisions are the student's own work, so they still import.
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });

      const cc = () => readAllEvents(paths).filter((e) => e.tool === 'claude-code');
      const decisions = cc().filter((e) => e.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(cc().filter((e) => e.type === 'ai_output').length).toBe(0);
      expect(decisions[0]!.text).toContain('**JWT** ✅');
      expect(decisions[0]!.tags).toContain('imported');
      expect(decisions[0]!.turnId).toBeDefined(); // attached to the prompt's turn

      // Re-importing the same transcript adds nothing (deduped by sourceId).
      const before = cc().length;
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });
      expect(cc().length).toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  test('the report shows the decision inline and counts it in the summary', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeDecisionTranscript(), 'utf8');
      await runImportClaudeCode(undefined, {
        file: fixture,
        withResponses: true,
        cwd: dir,
      });

      const data = buildReportData(paths);
      expect(data.summary.decisions).toBe(1);
      // The decision attached to its exchange.
      const turnWithDecision = data.turns.find((t) => t.decisions.length > 0);
      expect(turnWithDecision).toBeDefined();

      const md = renderMarkdown(data);
      expect(md).toContain('🔀 **Decision**');
      expect(md).toContain('**JWT** ✅');
      expect(md).toContain('1 decision(s)'); // summary line
    } finally {
      cleanup(dir);
    }
  });
});
