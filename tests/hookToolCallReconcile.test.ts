/**
 * Tool call + recap capture at Stop, end-to-end through the real hook
 * dispatcher (exercises whichever consumer path is active by default —
 * currently sole-writer/ledger mode — the same way `hookPlanReconcile.test.ts`
 * does for plans).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';

const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

/** A Claude transcript: a prompt, a failing Bash call, then a duration + recap. */
function toolCallTranscript(): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-06-10T10:00:00.000Z',
        promptSource: 'typed',
        sessionId: 's1',
        gitBranch: 'main',
        cwd: '.',
        message: { role: 'user', content: 'install pygame' },
      },
      {
        type: 'assistant',
        uuid: 'u2',
        timestamp: '2026-06-10T10:01:00.000Z',
        gitBranch: 'main',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 10 },
          content: [
            {
              type: 'tool_use',
              id: 'tb1',
              name: 'Bash',
              input: { command: 'pip3 install pygame' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        timestamp: '2026-06-10T10:02:00.000Z',
        gitBranch: 'main',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tb1',
              content: 'ERROR: no wheel for pygame',
              is_error: true,
            },
          ],
        },
      },
      {
        type: 'system',
        uuid: 's1',
        subtype: 'turn_duration',
        durationMs: 4200,
        timestamp: '2026-06-10T10:02:01.000Z',
        gitBranch: 'main',
      },
      {
        type: 'system',
        uuid: 's2',
        subtype: 'away_summary',
        content: 'Tried installing pygame; the wheel failed.',
        timestamp: '2026-06-10T10:02:02.000Z',
        gitBranch: 'main',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});
function tmp(): string {
  const d = makeTempDir();
  dirs.push(d);
  return d;
}

function stop(dir: string, transcript: string): { code: number } {
  const path = join(dir, 't.jsonl');
  writeFileSync(path, transcript);
  return run(
    dir,
    ['hook', 'stop'],
    JSON.stringify({ cwd: dir, session_id: 's1', transcript_path: path }),
  );
}

describe('tool call + recap capture at Stop', () => {
  test('captures the failed Bash call and the turn recap, under the right turn', () => {
    const dir = tmp();
    run(dir, ['track', '--project', 'Tools']);
    run(
      dir,
      ['hook', 'user-prompt'],
      JSON.stringify({ cwd: dir, prompt: 'install pygame', session_id: 's1' }),
    );
    const r = stop(dir, toolCallTranscript());
    expect(r.code).toBe(0);

    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(data.turns.length).toBe(1);
    const turn = data.turns[0];
    expect(turn.toolCalls.length).toBe(1);
    expect(turn.toolCalls[0].toolName).toBe('Bash');
    expect(turn.toolCalls[0].isError).toBe(true);
    expect(turn.toolCalls[0].text).toContain('pip3 install pygame');
    expect(turn.toolCalls[0].text).toContain('no wheel for pygame');
    expect(turn.recap.text).toBe('Tried installing pygame; the wheel failed.');
    expect(turn.recap.durationMs).toBe(4200);
    expect(data.summary.stats.totalDurationMs).toBe(4200);
  });

  test('a second identical Stop does not duplicate the tool call or recap', () => {
    const dir = tmp();
    run(dir, ['track', '--project', 'Tools']);
    run(
      dir,
      ['hook', 'user-prompt'],
      JSON.stringify({ cwd: dir, prompt: 'install pygame', session_id: 's1' }),
    );
    const transcript = toolCallTranscript();
    stop(dir, transcript);
    stop(dir, transcript); // idempotent re-run

    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(data.turns[0].toolCalls.length).toBe(1);
    expect(data.summary.stats.totalDurationMs).toBe(4200);
  });

  test('captureToolCalls: false suppresses the tool call but keeps the recap', () => {
    const dir = tmp();
    run(dir, ['track', '--project', 'Tools']);
    const configPath = join(dir, '.showtail', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.settings.captureToolCalls = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    run(
      dir,
      ['hook', 'user-prompt'],
      JSON.stringify({ cwd: dir, prompt: 'install pygame', session_id: 's1' }),
    );
    stop(dir, toolCallTranscript());

    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(data.turns[0].toolCalls.length).toBe(0);
    // Recap/duration is process telemetry, not gated by captureToolCalls.
    expect(data.turns[0].recap.durationMs).toBe(4200);
  });
});
