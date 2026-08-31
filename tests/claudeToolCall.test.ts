import { describe, expect, test } from 'bun:test';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { makeTempDir, cleanup } from './helpers.ts';

/**
 * A transcript with a Bash tool call (success), a failing Bash tool call, a
 * TodoWrite call (should be dropped as noise), and an end-of-turn
 * `turn_duration` + `away_summary` pair — modeled on a real captured transcript.
 */
function makeToolCallTranscript(): string {
  const lines: unknown[] = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-15T01:22:10.000Z',
      gitBranch: 'main',
      promptSource: 'typed',
      sessionId: 'sess-1',
      message: { role: 'user', content: 'Write a snake game.' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-08-15T01:22:11.000Z',
      gitBranch: 'main',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 2,
          output_tokens: 336,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        content: [
          { type: 'text', text: 'Checking for pygame first.' },
          {
            type: 'tool_use',
            id: 'tb1',
            name: 'Bash',
            input: { command: 'python3 -c "import pygame"' },
          },
          {
            type: 'tool_use',
            id: 'tt1',
            name: 'TodoWrite',
            input: { todos: [{ content: 'write game', status: 'pending' }] },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-08-15T01:22:12.000Z',
      gitBranch: 'main',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tb1',
            content: "Exit code 1\nModuleNotFoundError: No module named 'pygame'",
            is_error: true,
          },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-08-15T01:22:13.000Z',
      gitBranch: 'main',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 2,
          output_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        content: [
          {
            type: 'tool_use',
            id: 'tb2',
            name: 'Bash',
            input: { command: 'pip3 install pygame-ce' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-08-15T01:22:14.000Z',
      gitBranch: 'main',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tb2',
            content: 'Successfully installed pygame-ce-2.5.8',
            is_error: false,
          },
        ],
      },
    },
    {
      type: 'system',
      uuid: 's1',
      subtype: 'turn_duration',
      durationMs: 53479,
      messageCount: 34,
      timestamp: '2026-08-15T01:22:15.000Z',
      gitBranch: 'main',
    },
    {
      type: 'system',
      uuid: 's2',
      subtype: 'away_summary',
      content: 'Building a simple Snake game in pygame.',
      timestamp: '2026-08-15T01:22:16.000Z',
      gitBranch: 'main',
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseClaudeTranscript — tool calls', () => {
  test('captures a successful Bash call, header + truncated output', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeToolCallTranscript(), dir);
      const call = messages.find((m) => m.sourceId === 'tb2');
      expect(call).toBeDefined();
      expect(call!.role).toBe('tool_call');
      expect(call!.toolName).toBe('Bash');
      expect(call!.isError).toBe(false);
      expect(call!.text).toContain('$ pip3 install pygame-ce');
      expect(call!.text).toContain('Successfully installed pygame-ce-2.5.8');
    } finally {
      cleanup(dir);
    }
  });

  test('marks a failed Bash call as an error and includes its output', () => {
    const dir = makeTempDir();
    try {
      const { messages, events } = parseClaudeTranscript(makeToolCallTranscript(), dir);
      const call = messages.find((m) => m.sourceId === 'tb1');
      expect(call).toBeDefined();
      expect(call!.isError).toBe(true);
      expect(call!.text).toContain('**Error:**');
      expect(call!.text).toContain("ModuleNotFoundError: No module named 'pygame'");

      const result = events.find(
        (event) => event.type === 'tool_result' && event.toolUseId === 'tb1',
      );
      expect(result).toMatchObject({ exitCode: 1, isError: true });
    } finally {
      cleanup(dir);
    }
  });

  test('drops TodoWrite as noise', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeToolCallTranscript(), dir);
      expect(messages.find((m) => m.sourceId === 'tt1')).toBeUndefined();
      expect(messages.some((m) => m.toolName === 'TodoWrite')).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('parseClaudeTranscript — recap', () => {
  test('pairs turn_duration with away_summary into one recap message', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeToolCallTranscript(), dir);
      const recaps = messages.filter((m) => m.role === 'recap');
      expect(recaps.length).toBe(1);
      const recap = recaps[0]!;
      expect(recap.sourceId).toBe('s2');
      expect(recap.text).toBe('Building a simple Snake game in pygame.');
      expect(recap.durationMs).toBe(53479);
      expect(recap.gitBranch).toBe('main');
    } finally {
      cleanup(dir);
    }
  });

  test('sums token usage across the turn onto the recap', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeToolCallTranscript(), dir);
      const recap = messages.find((m) => m.role === 'recap')!;
      expect(recap.inputTokens).toBe(4);
      expect(recap.outputTokens).toBe(436);
      expect(recap.cacheReadTokens).toBe(110);
      expect(recap.cacheCreationTokens).toBe(55);
    } finally {
      cleanup(dir);
    }
  });

  test('flushes a duration with no following away_summary at end-of-transcript', () => {
    const dir = makeTempDir();
    try {
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-15T02:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'sess-2',
          message: { role: 'user', content: 'Do a thing.' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-15T02:00:01.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'Done.' }],
          },
        },
        {
          type: 'system',
          uuid: 's1',
          subtype: 'turn_duration',
          durationMs: 12000,
          timestamp: '2026-08-15T02:00:02.000Z',
        },
      ];
      const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { messages } = parseClaudeTranscript(content, dir);
      const recap = messages.find((m) => m.role === 'recap');
      expect(recap).toBeDefined();
      expect(recap!.durationMs).toBe(12000);
      expect(recap!.text).toBe('');
      expect(recap!.sourceId).toBe('s1');
    } finally {
      cleanup(dir);
    }
  });

  test('counts one API response`s usage once, even split across thinking/tool_use lines', () => {
    const dir = makeTempDir();
    try {
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-15T02:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'sess-3',
          message: { role: 'user', content: 'do a thing' },
        },
        // One API response split across two transcript lines (thinking, then
        // tool_use), sharing the same message.id and an identical usage copy —
        // exactly how Claude Code writes a multi-block response.
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-15T02:00:01.000Z',
          message: {
            id: 'msg_shared_1',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 2, output_tokens: 694 },
            content: [{ type: 'thinking', text: 'thinking...' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2026-08-15T02:00:02.000Z',
          message: {
            id: 'msg_shared_1',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 2, output_tokens: 694 },
            content: [
              {
                type: 'tool_use',
                id: 'tb1',
                name: 'Bash',
                input: { command: 'echo hi' },
              },
            ],
          },
        },
        // A second, distinct API response — must still be counted.
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-08-15T02:00:03.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tb1', content: 'hi' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2026-08-15T02:00:04.000Z',
          message: {
            id: 'msg_distinct_2',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 3, output_tokens: 100 },
            content: [{ type: 'text', text: 'Done.' }],
          },
        },
        {
          type: 'system',
          uuid: 's1',
          subtype: 'turn_duration',
          durationMs: 1000,
          timestamp: '2026-08-15T02:00:05.000Z',
        },
        {
          type: 'system',
          uuid: 's2',
          subtype: 'away_summary',
          content: 'Did a thing.',
          timestamp: '2026-08-15T02:00:06.000Z',
        },
      ];
      const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { messages } = parseClaudeTranscript(content, dir);
      const recap = messages.find((m) => m.role === 'recap')!;
      // 694 (counted once, not twice) + 100 = 794, not 1488.
      expect(recap.outputTokens).toBe(794);
      expect(recap.inputTokens).toBe(5);
    } finally {
      cleanup(dir);
    }
  });

  test('a turn spanning two Stop-hook cycles (backgrounded task) produces one recap with summed duration', () => {
    const dir = makeTempDir();
    try {
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-15T02:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'sess-4',
          message: { role: 'user', content: 'make a game and run it in the background' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-15T02:00:01.000Z',
          message: {
            id: 'msg_1',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 2, output_tokens: 50 },
            content: [{ type: 'text', text: "I'll launch it in the background." }],
          },
        },
        // First Stop-hook cycle ends with a duration but no summary yet — the
        // backgrounded command is still running.
        {
          type: 'system',
          uuid: 's1',
          subtype: 'turn_duration',
          durationMs: 79169,
          timestamp: '2026-08-15T02:01:00.000Z',
        },
        // The backgrounded command finishes; Claude Code injects a synthetic,
        // system-sourced notification — never a real prompt.
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-08-15T02:02:00.000Z',
          promptSource: 'system',
          message: {
            role: 'user',
            content:
              '<task-notification>\n<summary>Background command completed</summary>\n</task-notification>',
          },
        },
        // A thinking-only continuation of the SAME turn — must not flush the
        // pending duration early.
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2026-08-15T02:02:01.000Z',
          message: {
            id: 'msg_2',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 1, output_tokens: 20 },
            content: [{ type: 'thinking', text: 'checking the output...' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2026-08-15T02:02:02.000Z',
          message: {
            id: 'msg_2',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 1, output_tokens: 20 },
            content: [{ type: 'text', text: 'The game window closed cleanly.' }],
          },
        },
        // Second Stop-hook cycle: its duration must SUM with the first, and
        // this away_summary is the turn's only recap.
        {
          type: 'system',
          uuid: 's2',
          subtype: 'turn_duration',
          durationMs: 4530,
          timestamp: '2026-08-15T02:02:03.000Z',
        },
        {
          type: 'system',
          uuid: 's3',
          subtype: 'away_summary',
          content: 'Built a game; it ran and closed cleanly.',
          timestamp: '2026-08-15T02:02:04.000Z',
        },
      ];
      const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { messages } = parseClaudeTranscript(content, dir);

      const recaps = messages.filter((m) => m.role === 'recap');
      expect(recaps.length).toBe(1); // not two — no spurious empty-text recap
      expect(recaps[0]!.text).toBe('Built a game; it ran and closed cleanly.');
      expect(recaps[0]!.durationMs).toBe(79169 + 4530);

      // Both assistant texts still attach — nothing dropped by the continuation.
      const assistantTexts = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.text);
      expect(assistantTexts).toContain("I'll launch it in the background.");
      expect(assistantTexts).toContain('The game window closed cleanly.');
    } finally {
      cleanup(dir);
    }
  });
});

describe('parseClaudeTranscript — background task completions', () => {
  /** A turn that backgrounds a Bash command, then is told how it finished. */
  function backgroundTranscript(status: string, summary: string): string {
    const lines: unknown[] = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-15T03:32:38.000Z',
        promptSource: 'typed',
        sessionId: 'sess-bg',
        message: { role: 'user', content: 'yes' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-15T03:32:41.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2, output_tokens: 50 },
          content: [
            {
              type: 'tool_use',
              id: 'toolu_bg1',
              name: 'Bash',
              input: { command: 'cd ~/cat_game && python3 main.py' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-15T03:32:42.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_bg1',
              content: 'Command running in background with ID: br76pb576.',
              is_error: false,
            },
          ],
        },
      },
      // First Stop cycle closes while the command is still running.
      {
        type: 'system',
        uuid: 's1',
        subtype: 'turn_duration',
        durationMs: 5433,
        timestamp: '2026-08-15T03:32:44.000Z',
      },
      // The background command finishes — reported on a tooling-injected line.
      {
        type: 'user',
        uuid: 'u3',
        timestamp: '2026-08-15T03:32:47.000Z',
        promptSource: 'system',
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>br76pb576</task-id>\n' +
            '<tool-use-id>toolu_bg1</tool-use-id>\n' +
            `<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-08-15T03:32:49.000Z',
        message: {
          id: 'msg_2',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 20 },
          content: [{ type: 'text', text: 'The game window closed cleanly again.' }],
        },
      },
      {
        type: 'system',
        uuid: 's2',
        subtype: 'turn_duration',
        durationMs: 1893,
        timestamp: '2026-08-15T03:32:50.000Z',
      },
      {
        type: 'system',
        uuid: 's3',
        subtype: 'away_summary',
        content: 'Relaunched the game with passive dogs.',
        timestamp: '2026-08-15T03:35:00.000Z',
      },
    ];
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  const COMPLETED =
    'Background command "Launch the top-down cat game with passive dogs" completed (exit code 0)';

  test('captures the completion notice as its own tool call', () => {
    const dir = makeTempDir();
    try {
      const { messages, events } = parseClaudeTranscript(
        backgroundTranscript('completed', COMPLETED),
        dir,
      );
      const note = messages.find((m) => m.sourceId === 'u3');
      expect(note).toBeDefined();
      expect(note!.role).toBe('tool_call');
      expect(note!.toolName).toBe('Background task');
      expect(note!.text).toBe(COMPLETED);
      expect(note!.isError).toBe(false);

      // It reads after the launch and before the closing reply, as it happened.
      const order = messages.map((m) => m.sourceId);
      expect(order.indexOf('toolu_bg1')).toBeLessThan(order.indexOf('u3'));
      expect(order.indexOf('u3')).toBeLessThan(order.indexOf('a2'));
      expect(events.find((event) => event.sourceId === 'u3')).toMatchObject({
        type: 'tool_result',
        toolUseId: 'toolu_bg1',
        content: COMPLETED,
      });
    } finally {
      cleanup(dir);
    }
  });

  test('a failed task is flagged; a killed one is not', () => {
    const dir = makeTempDir();
    try {
      const failed = parseClaudeTranscript(
        backgroundTranscript('failed', 'Agent "Build docs" failed: stalled'),
        dir,
      ).messages.find((m) => m.sourceId === 'u3');
      expect(failed!.isError).toBe(true);
      expect(failed!.text).toContain('failed: stalled');

      // A killed task is the student deliberately stopping it, not a failure.
      const killed = parseClaudeTranscript(
        backgroundTranscript('killed', 'Background command "Launch" was stopped'),
        dir,
      ).messages.find((m) => m.sourceId === 'u3');
      expect(killed!.isError).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('the notice opens no turn and does not split the turn`s recap', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(
        backgroundTranscript('completed', COMPLETED),
        dir,
      );
      // Only the student's own "yes" is a prompt.
      const prompts = messages.filter((m) => m.role === 'user');
      expect(prompts.length).toBe(1);
      expect(prompts[0]!.text).toBe('yes');

      // One recap, summing both Stop cycles the turn spanned.
      const recaps = messages.filter((m) => m.role === 'recap');
      expect(recaps.length).toBe(1);
      expect(recaps[0]!.durationMs).toBe(5433 + 1893);
      expect(recaps[0]!.text).toBe('Relaunched the game with passive dogs.');
    } finally {
      cleanup(dir);
    }
  });
});
