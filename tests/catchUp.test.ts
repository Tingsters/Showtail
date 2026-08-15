/**
 * Catch-up sweep: recovering the part of a session the live hooks could not see.
 *
 * Hosts write their transcript asynchronously ("may lag current turn") and
 * append the end-of-turn recap minutes after the last hook has run — so a
 * session's final exchange is invisible at Stop time and has no later Stop to
 * heal it. `showtail report` re-reads the transcript first; these tests drive
 * that through the real CLI, with a transcript that grows *after* the hooks ran.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';

const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});
function tmp(): string {
  const d = makeTempDir();
  dirs.push(d);
  return d;
}

/** The turn as the Stop hook sees it: the host hasn't written the ending yet. */
function laggingTranscript(cwd: string): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-15T10:00:00.000Z',
        promptSource: 'typed',
        sessionId: 'sess-catchup',
        cwd,
        message: { role: 'user', content: 'make it a top down game' },
      },
      // The turn launches the game in the background…
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-15T10:00:10.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 200 },
          content: [
            {
              type: 'tool_use',
              id: 'tb1',
              name: 'Bash',
              input: { command: 'cd ~/cat_game && python3 main.py' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1b',
        timestamp: '2026-08-15T10:00:12.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tb1',
              content: 'Command running in background with ID: br76pb576.',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a1b',
        timestamp: '2026-08-15T10:00:15.000Z',
        message: {
          id: 'msg_1b',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 30 },
          content: [{ type: 'text', text: "I've rewritten it as a top-down game." }],
        },
      },
      // The Stop fires here: a duration, but the recap does not exist yet —
      // and the backgrounded command has not finished either.
      {
        type: 'system',
        uuid: 's1',
        subtype: 'turn_duration',
        durationMs: 104954,
        timestamp: '2026-08-15T10:00:16.000Z',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

/** The same turn once the host has caught up: closing message + recap appended. */
function completedTranscript(cwd: string): string {
  return (
    laggingTranscript(cwd) +
    [
      // A backgrounded task finished — a synthetic, system-sourced line that
      // must not open a turn of its own.
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-15T10:00:50.000Z',
        promptSource: 'system',
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content:
            '<task-notification>\n<tool-use-id>tb1</tool-use-id>\n<status>completed</status>\n' +
            '<summary>Background command "Launch the game" completed (exit code 0)</summary>\n' +
            '</task-notification>',
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-08-15T10:00:52.000Z',
        message: {
          id: 'msg_2',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2, output_tokens: 90 },
          content: [{ type: 'text', text: 'The game window closed cleanly.' }],
        },
      },
      {
        type: 'system',
        uuid: 's2',
        subtype: 'turn_duration',
        durationMs: 2292,
        timestamp: '2026-08-15T10:00:53.000Z',
      },
      {
        type: 'system',
        uuid: 's3',
        subtype: 'away_summary',
        content: 'Built a top-down cat game; it ran and closed cleanly.',
        timestamp: '2026-08-15T10:03:55.000Z',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') +
    '\n'
  );
}

/** Track a project and drive one prompt + Stop against a lagging transcript. */
function seedLaggingSession(dir: string): string {
  const transcript = join(dir, 't.jsonl');
  run(dir, ['track', '--project', 'Catchup']);
  run(
    dir,
    ['hook', 'user-prompt'],
    JSON.stringify({
      cwd: dir,
      prompt: 'make it a top down game',
      session_id: 'sess-catchup',
    }),
  );
  writeFileSync(transcript, laggingTranscript(dir));
  run(
    dir,
    ['hook', 'stop'],
    JSON.stringify({ cwd: dir, session_id: 'sess-catchup', transcript_path: transcript }),
  );
  return transcript;
}

describe('report catch-up sweep', () => {
  test('recovers the closing message and recap the hooks never saw', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);

    // Before: the Stop only ever saw the lagging file.
    run(dir, ['report', '--format', 'json', '--no-sync']);
    const before = readJsonReport(dir);
    const beforeTexts = before.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(beforeTexts).not.toContain('The game window closed cleanly.');
    expect(before.turns[0].recap?.text ?? '').toBe('');

    // The host catches up — no further hook ever runs.
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json']);
    const after = readJsonReport(dir);
    const afterTexts = after.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(afterTexts).toContain('The game window closed cleanly.');
    expect(after.turns[0].recap.text).toBe(
      'Built a top-down cat game; it ran and closed cleanly.',
    );
    // Still a single turn — the task-notification never opened one.
    expect(after.turns.length).toBe(1);

    // The background command's launch AND how it finished are both shown.
    const calls = after.turns[0].toolCalls;
    expect(calls.map((c: { toolName: string }) => c.toolName)).toEqual([
      'Bash',
      'Background task',
    ]);
    expect(calls[1].text).toBe(
      'Background command "Launch the game" completed (exit code 0)',
    );
  });

  test('counts a turn`s duration once even when it captured a partial recap first', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));
    run(dir, ['report', '--format', 'json']);

    const data = readJsonReport(dir);
    // The partial recap (104954) and the complete one (104954 + 2292) both live
    // in the trail; the report must count only the chosen one.
    expect(data.turns[0].recap.durationMs).toBe(107246);
    expect(data.summary.stats.totalDurationMs).toBe(107246);
  });

  test('is idempotent — repeated reports add nothing', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json']);
    const first = readJsonReport(dir).summary.events;
    run(dir, ['report', '--format', 'json']);
    run(dir, ['report', '--format', 'json']);
    expect(readJsonReport(dir).summary.events).toBe(first);
  });

  test('--no-sync leaves the trail untouched', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json', '--no-sync']);
    const data = readJsonReport(dir);
    const texts = data.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(texts).not.toContain('The game window closed cleanly.');
  });
});
