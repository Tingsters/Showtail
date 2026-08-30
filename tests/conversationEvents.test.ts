import { describe, expect, test } from 'bun:test';
import { readJournal } from '../src/core/journal.ts';
import { parseClaudeTranscript, importClaudeTranscript } from '../src/core/claudeCode.ts';
import { logEvent, readAllEvents } from '../src/core/events.ts';
import { logConversationEvent } from '../src/core/conversationEvents.ts';
import { buildReportData } from '../src/core/report.ts';
import { runInit } from '../src/commands/init.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

function fullClaudeTranscript(root: string): string {
  const line = (value: unknown) => JSON.stringify(value);
  return (
    [
      line({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-08-30T10:00:00.000Z',
        promptSource: 'typed',
        sessionId: 'claude-session-1',
        message: { role: 'user', content: 'Build the demo.' },
      }),
      line({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-08-30T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            { type: 'text', text: 'I need one design choice first.' },
            {
              type: 'tool_use',
              id: 'ask-1',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Which style?',
                    header: 'Style',
                    options: [
                      { label: 'Simple', description: 'Keep it small.' },
                      { label: 'Detailed', description: 'Add more features.' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'answer-1',
        timestamp: '2026-08-30T10:00:02.000Z',
        toolUseResult: { answers: { 'Which style?': 'Simple' } },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'ask-1',
              content: 'Your questions have been answered: "Which style?"="Simple".',
            },
          ],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'assistant-2',
        timestamp: '2026-08-30T10:00:03.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            {
              type: 'tool_use',
              id: 'plan-1',
              name: 'ExitPlanMode',
              input: { plan: '# Demo plan\n\nWrite and run `main.py`.' },
            },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'approval-1',
        timestamp: '2026-08-30T10:00:04.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'plan-1',
              content: 'User has approved your plan. You can now start coding.',
            },
          ],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'assistant-3',
        timestamp: '2026-08-30T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: { file_path: `${root}/main.py`, content: "print('ok')\n" },
            },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'write-result-1',
        timestamp: '2026-08-30T10:00:06.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'write-1', content: 'written' }],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'assistant-4',
        timestamp: '2026-08-30T10:00:07.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            {
              type: 'tool_use',
              id: 'bash-1',
              name: 'Bash',
              input: { command: 'python3 main.py' },
            },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'bash-result-1',
        timestamp: '2026-08-30T10:00:08.000Z',
        toolUseResult: { stdout: 'ok\n', stderr: '', exitCode: 0 },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok\n' }],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'assistant-5',
        timestamp: '2026-08-30T10:00:09.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'The demo is complete.' }],
        },
      }),
    ].join('\n') + '\n'
  );
}

describe('structured conversation events', () => {
  test('exports a lossless schema-v2 Claude turn without changing human event counts', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const transcript = parseClaudeTranscript(fullClaudeTranscript(dir), dir);

      await importClaudeTranscript(author, transcript, { withResponses: true });
      const conversationCount = readJournal(author).filter(
        (entry) => entry.kind === 'conversation',
      ).length;
      await importClaudeTranscript(author, transcript, { withResponses: true });
      expect(
        readJournal(author).filter((entry) => entry.kind === 'conversation'),
      ).toHaveLength(conversationCount);

      const report = buildReportData(paths);
      expect(report.schemaVersion).toBe(2);
      expect(report.summary.events).toBe(readAllEvents(paths).length);
      expect(report.turns).toHaveLength(1);

      const events = report.turns[0]!.events;
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_, index) => index),
      );
      expect(events.map((event) => event.type)).toEqual([
        'user_text',
        'assistant_text',
        'tool_use',
        'tool_result',
        'tool_use',
        'plan_snapshot',
        'tool_result',
        'plan_approved',
        'tool_use',
        'tool_result',
        'tool_use',
        'tool_result',
        'assistant_text',
      ]);
      expect(
        events.find((event) => event.toolUseId === 'ask-1' && event.type === 'tool_use')
          ?.input,
      ).toMatchObject({
        questions: [{ question: 'Which style?', header: 'Style' }],
      });
      expect(
        events.find(
          (event) => event.toolUseId === 'ask-1' && event.type === 'tool_result',
        )?.content,
      ).toEqual({
        answers: { 'Which style?': 'Simple' },
      });
      expect(events.find((event) => event.type === 'plan_snapshot')?.plan).toContain(
        'Demo plan',
      );
      expect(
        events.find((event) => event.toolUseId === 'write-1' && event.type === 'tool_use')
          ?.input,
      ).toMatchObject({
        file_path: `${dir}/main.py`,
        content: "print('ok')\n",
      });
      expect(
        events.find(
          (event) => event.toolUseId === 'bash-1' && event.type === 'tool_result',
        ),
      ).toMatchObject({
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
      });
      expect(events.at(-1)?.text).toBe('The demo is complete.');
    } finally {
      cleanup(dir);
    }
  });

  test('synthesizes valid v2 events for a legacy trail', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'Legacy prompt',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Legacy answer',
        turnId: prompt.id,
      });
      const report = buildReportData(paths);
      expect(report.turns[0]!.events.map((event) => event.type)).toEqual([
        'user_text',
        'assistant_text',
      ]);
    } finally {
      cleanup(dir);
    }
  });

  test('an incremental re-import attaches new raw events to the existing prompt', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const user = {
        type: 'user',
        uuid: 'incremental-user',
        timestamp: '2026-08-30T11:00:00.000Z',
        promptSource: 'typed',
        sessionId: 'incremental-session',
        message: { role: 'user', content: 'Continue the work.' },
      };
      const assistant = {
        type: 'assistant',
        uuid: 'incremental-assistant',
        timestamp: '2026-08-30T11:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Newly appended answer.' }],
        },
      };
      await importClaudeTranscript(
        author,
        parseClaudeTranscript(`${JSON.stringify(user)}\n`, dir),
        { withResponses: true },
      );
      await importClaudeTranscript(
        author,
        parseClaudeTranscript(
          `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`,
          dir,
        ),
        { withResponses: true },
      );
      expect(buildReportData(paths).turns[0]!.events.at(-1)?.text).toBe(
        'Newly appended answer.',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('prompt-only imports keep decisions, plans, and edits but omit other AI activity', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const transcript = parseClaudeTranscript(fullClaudeTranscript(dir), dir);
      await importClaudeTranscript(author, transcript);
      const events = buildReportData(paths).turns[0]!.events;
      expect(events.some((event) => event.type === 'assistant_text')).toBe(false);
      expect(events.some((event) => event.toolName === 'AskUserQuestion')).toBe(true);
      expect(events.some((event) => event.toolName === 'ExitPlanMode')).toBe(true);
      expect(events.some((event) => event.toolName === 'Write')).toBe(true);
      expect(events.some((event) => event.toolName === 'Bash')).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('redacts structured payload strings before object storage and report export', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'Write the configuration.',
      });
      logConversationEvent(author, {
        tool: 'claude-code',
        turnId: prompt.id,
        event: {
          sequence: 0,
          type: 'tool_use',
          sourceId: 'secret-write:use',
          toolUseId: 'secret-write',
          toolName: 'Write',
          input: { content: 'API_KEY=sk-abcdefghijklmnop' },
        },
      });
      const serialized = JSON.stringify(buildReportData(paths));
      expect(serialized).not.toContain('sk-abcdefghijklmnop');
      expect(serialized).toContain('redacted');
    } finally {
      cleanup(dir);
    }
  });
});
