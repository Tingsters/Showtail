/**
 * Plan capture at Stop, end-to-end through the real hook dispatcher.
 *
 * Two paths are exercised:
 *  - Claude Code: the plan lives only on the transcript (`ExitPlanMode`); the
 *    reconcile materializes that text into a linkable `plans/<id>.md`, and a
 *    second Stop does not duplicate it.
 *  - Antigravity CLI: the host wrote a real `plan.md`; the reconcile links THAT
 *    file (its on-disk content), not the transcript text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, readJsonReport, runCli, spawnEnv } from './helpers.ts';

const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

/** A Claude transcript: a prompt, an approved `ExitPlanMode` plan, and its result. */
function claudePlanTranscript(plan: string): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-06-10T10:00:00.000Z',
        promptSource: 'typed',
        sessionId: 's1',
        cwd: '.',
        message: { role: 'user', content: 'build a thing' },
      },
      {
        type: 'assistant',
        uuid: 'u2',
        timestamp: '2026-06-10T10:01:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [
            { type: 'tool_use', id: 'ep1', name: 'ExitPlanMode', input: { plan } },
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
              tool_use_id: 'ep1',
              content: 'User has approved your plan. You can now start coding.',
            },
          ],
        },
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

describe('Claude Code plan capture at Stop', () => {
  test('materializes the transcript plan into a linkable file', () => {
    const dir = tmp();
    run(dir, ['track', '--project', 'Plan']);
    run(
      dir,
      ['hook', 'user-prompt'],
      JSON.stringify({ cwd: dir, prompt: 'build a thing', session_id: 's1' }),
    );
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, claudePlanTranscript('# My Plan\n\nDo the thing.'));
    const r = run(
      dir,
      ['hook', 'stop'],
      JSON.stringify({ cwd: dir, session_id: 's1', transcript_path: transcript }),
    );
    expect(r.code).toBe(0);

    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(data.plans.length).toBe(1);
    expect(data.plans[0].planPath).toBe('plans/ep1.md');
    expect(data.plans[0].status).toBe('approved');
    const file = join(dir, '.showtail', 'plans', 'ep1.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Do the thing');
  });

  test('a second Stop does not duplicate the plan or its file', () => {
    const dir = tmp();
    run(dir, ['track', '--project', 'Plan']);
    run(
      dir,
      ['hook', 'user-prompt'],
      JSON.stringify({ cwd: dir, prompt: 'build a thing', session_id: 's1' }),
    );
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, claudePlanTranscript('# My Plan\n\nDo the thing.'));
    const stop = JSON.stringify({
      cwd: dir,
      session_id: 's1',
      transcript_path: transcript,
    });
    run(dir, ['hook', 'stop'], stop);
    run(dir, ['hook', 'stop'], stop); // idempotent re-run

    run(dir, ['report', '--format', 'json']);
    const data = readJsonReport(dir);
    expect(data.plans.length).toBe(1);
    expect(data.summary.plans).toBe(1);
  });
});

describe('Antigravity CLI plan capture at Stop', () => {
  const SID = 'sess-agy-1';

  /** Seed the conversation's transcript + a real plan.md under a temp GEMINI_HOME. */
  function seedAgy(home: string): { transcriptPath: string } {
    const brain = join(home, 'antigravity-cli', 'brain', SID);
    const logs = join(brain, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    const transcriptPath = join(logs, 'transcript.jsonl');
    const transcript =
      [
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-06-10T10:00:00Z',
          content: '<USER_REQUEST>\nBuild a retry helper for fetch.\n</USER_REQUEST>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-06-10T10:01:00Z',
          tool_calls: [
            { name: 'create_plan', args: { plan: '1. step one\n2. step two' } },
          ],
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-06-10T10:02:00Z',
          content: 'Done — added the helper.',
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n';
    writeFileSync(transcriptPath, transcript);
    // The real, canonical plan file the report should link to.
    writeFileSync(join(brain, 'plan.md'), '# Real Plan File\n- this came from disk\n');
    return { transcriptPath };
  }

  test('links the real on-disk plan.md, using its content', () => {
    const home = tmp();
    const dir = tmp();
    const { transcriptPath } = seedAgy(home);
    const env = { ...spawnEnv(), GEMINI_HOME: home };

    runCli(dir, ['track', '--project', 'Plan'], { env });
    runCli(dir, ['hook', 'user-prompt', '--tool', 'antigravity-cli'], {
      env,
      input: JSON.stringify({
        conversationId: SID,
        prompt: 'Build a retry helper for fetch.',
      }),
    });
    const r = runCli(dir, ['hook', 'stop', '--tool', 'antigravity-cli'], {
      env,
      input: JSON.stringify({ conversationId: SID, transcriptPath }),
    });
    expect(r.code).toBe(0);

    runCli(dir, ['report', '--format', 'json'], { env });
    const data = readJsonReport(dir);
    const planPath = `plans/agy-plan_${SID}.md`;
    expect(data.plans.length).toBeGreaterThanOrEqual(1);
    expect(data.plans.every((p: { planPath?: string }) => p.planPath === planPath)).toBe(
      true,
    );
    // The linked file is the on-disk plan.md, not the transcript's plan text.
    const file = join(dir, '.showtail', planPath);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('this came from disk');
  });
});
