import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  antigravityCliBrainDir,
  findAntigravityCliTranscripts,
  locateAntigravityCliTranscript,
  parseAntigravityCliTranscript,
} from '../src/core/antigravityCliTranscript.ts';
import { cleanup, makeTempDir, readJsonReport, runCli, spawnEnv } from './helpers.ts';

/**
 * Build a synthetic Antigravity `transcript.jsonl` (one JSON object per line)
 * mixing the line shapes we keep — `USER_INPUT` (wrapped prompt), a plan via a
 * `PLANNER_RESPONSE` plan tool call, a `PLAN`-type line, `CODE_ACTION` (edit),
 * and a `PLANNER_RESPONSE` text reply — with the tool noise we must drop
 * (`VIEW_FILE`, `RUN_COMMAND`, `CHECKPOINT`, `CONVERSATION_HISTORY`).
 */
function makeTranscript(): string {
  const lines: unknown[] = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-06-23T03:42:50Z',
      content:
        '<USER_REQUEST>\nBuild a retry helper for fetch.\n</USER_REQUEST>\n' +
        '<ADDITIONAL_METADATA>\nThe current local time is: 2026-06-22T20:42:50-07:00.\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'SYSTEM',
      type: 'CONVERSATION_HISTORY',
      status: 'DONE',
      created_at: '2026-06-23T03:42:51Z',
    },
    // The generated PLAN via a plan tool call — Antigravity's signature win.
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-23T03:42:52Z',
      tool_calls: [
        {
          name: 'create_plan',
          args: {
            plan: '1. Add fetchWithRetry\n2. Wire it into the client\n3. Add a test',
          },
        },
      ],
    },
    // A tool-only planner turn (reads a file) — no reply text, nothing emitted.
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-23T03:42:53Z',
      tool_calls: [{ name: 'view_file', args: { path: 'client.ts' } }],
    },
    { step_index: 4, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-06-23T03:42:53Z', content: 'noise' },
    // A dedicated PLAN-type line (an alternate plan representation) — kept.
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLAN',
      status: 'DONE',
      created_at: '2026-06-23T03:42:54Z',
      content: '## Implementation Plan\n- step one\n- step two',
    },
    // An edit — kept as role 'edit' by the full parse, dropped by the transcript.
    {
      step_index: 6,
      source: 'MODEL',
      type: 'CODE_ACTION',
      status: 'DONE',
      created_at: '2026-06-23T03:42:55Z',
      content: 'The following changes were made by replace_file_content to client.ts',
    },
    { step_index: 7, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-06-23T03:42:56Z', content: 'bun test' },
    // The final assistant text reply.
    {
      step_index: 8,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-23T03:42:57Z',
      content: 'I added a retry helper and wired it in.',
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Write a synthetic transcript into a temp `.gemini` home's brain layout. */
function seedTranscript(geminiHome: string, sessionId: string, content: string): string {
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = geminiHome;
  try {
    const dir = join(
      antigravityCliBrainDir(),
      sessionId,
      '.system_generated',
      'logs',
    );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, content);
    return path;
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
}

describe('parseAntigravityCliTranscript', () => {
  test('emits user, plan (tool call + PLAN line) and assistant; drops noise + edits', () => {
    const dir = makeTempDir();
    try {
      const t = parseAntigravityCliTranscript(makeTranscript(), dir, 'sess-agy-1');
      expect(t.sessionId).toBe('sess-agy-1');

      const roles = t.messages.map((m) => m.role);
      // edits and tool noise are gone; we keep user / plan / plan / assistant.
      expect(roles).toEqual(['user', 'plan', 'plan', 'assistant']);

      // The user prompt is de-wrapped (no <USER_REQUEST>/<ADDITIONAL_METADATA>).
      const user = t.messages.find((m) => m.role === 'user')!;
      expect(user.text).toBe('Build a retry helper for fetch.');
      expect(user.text).not.toContain('USER_REQUEST');
      expect(user.text).not.toContain('ADDITIONAL_METADATA');
      expect(user.sourceId).toBe('agy:user:sess-agy-1:0');

      // The plan from the tool call carries the plan markdown and is approved.
      const plans = t.messages.filter((m) => m.role === 'plan');
      expect(plans.length).toBe(2);
      expect(plans[0]!.text).toContain('fetchWithRetry');
      expect(plans[0]!.approved).toBe(true);
      expect(plans[0]!.sourceId).toBe('agy:plan:sess-agy-1:2:0');
      // The dedicated PLAN line is captured too.
      expect(plans[1]!.text).toContain('Implementation Plan');
      expect(plans[1]!.sourceId).toBe('agy:plan:sess-agy-1:5');

      // The assistant reply (a content-only planner turn) is kept.
      const asst = t.messages.find((m) => m.role === 'assistant')!;
      expect(asst.text).toBe('I added a retry helper and wired it in.');
      expect(asst.sourceId).toBe('agy:asst:sess-agy-1:8');

      // Timestamps preserved for back-dating.
      expect(user.timestamp).toBe('2026-06-23T03:42:50Z');
    } finally {
      cleanup(dir);
    }
  });

  test('renders a task-list plan tool call from an array of steps', () => {
    const dir = makeTempDir();
    try {
      const content =
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-06-23T03:00:00Z',
          tool_calls: [
            {
              name: 'update_task_list',
              args: { tasks: [{ title: 'Scaffold module' }, 'Write tests'] },
            },
          ],
        }) + '\n';
      const t = parseAntigravityCliTranscript(content, dir, 's2');
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0]!.role).toBe('plan');
      expect(t.messages[0]!.text).toContain('Scaffold module');
      expect(t.messages[0]!.text).toContain('Write tests');
    } finally {
      cleanup(dir);
    }
  });

  test('malformed lines are skipped, never thrown', () => {
    const dir = makeTempDir();
    try {
      const content =
        'not json\n' +
        JSON.stringify({ type: 'USER_INPUT', content: 'hi', created_at: 'x' }) +
        '\n{bad';
      const t = parseAntigravityCliTranscript(content, dir, 's3');
      expect(t.messages.map((m) => m.role)).toEqual(['user']);
      expect(t.messages[0]!.text).toBe('hi');
    } finally {
      cleanup(dir);
    }
  });
});

describe('antigravity transcript discovery', () => {
  test('finds transcripts under the brain dir and locates by session id, else newest', () => {
    const home = makeTempDir();
    try {
      seedTranscript(home, 'aaaa-1111', makeTranscript());
      seedTranscript(home, 'bbbb-2222', makeTranscript());

      const prev = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = home;
      try {
        const all = findAntigravityCliTranscripts();
        expect(all.length).toBe(2);
        expect(all.map((t) => t.sessionId).sort()).toEqual(['aaaa-1111', 'bbbb-2222']);

        // By id.
        const byId = locateAntigravityCliTranscript('aaaa-1111');
        expect(byId?.sessionId).toBe('aaaa-1111');

        // Unknown id falls back to the newest on disk.
        const newest = locateAntigravityCliTranscript('does-not-exist');
        expect(newest).not.toBeNull();
      } finally {
        if (prev === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = prev;
      }
    } finally {
      cleanup(home);
    }
  });

  test('no brain dir → no transcripts (guarded)', () => {
    const home = makeTempDir();
    const prev = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = home; // exists, but has no antigravity-cli/brain
    try {
      expect(findAntigravityCliTranscripts()).toEqual([]);
      expect(locateAntigravityCliTranscript(undefined)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = prev;
      cleanup(home);
    }
  });
});

describe('antigravity-cli getTranscript (stop reconcile)', () => {
  test('locates the session transcript by id and captures the plan + reply', () => {
    const dir = makeTempDir();
    const geminiHome = makeTempDir();
    try {
      const env = { ...spawnEnv(), GEMINI_HOME: geminiHome };
      const sid = 'sess-agy-e2e-1';

      runCli(dir, ['init', '--project', 'Antigravity Stop'], { env });
      // Log the prompt live so the Stop reconcile has an in-window turn to attach
      // the plan and reply to (mirrors how the user-prompt hook would fire).
      runCli(
        dir,
        ['hook', 'user-prompt', '--tool', 'antigravity-cli'],
        {
          env,
          input: JSON.stringify({
            cwd: dir,
            session_id: sid,
            prompt: 'Build a retry helper for fetch.',
          }),
        },
      );

      // Seed the transcript where `agy` writes it (under GEMINI_HOME's brain dir).
      seedTranscript(geminiHome, sid, makeTranscript());

      const stop = runCli(
        dir,
        ['hook', 'stop', '--tool', 'antigravity-cli'],
        { env, input: JSON.stringify({ cwd: dir, session_id: sid }) },
      );
      expect(stop.code).toBe(0);

      runCli(dir, ['report', '--format', 'json'], { env });
      const data = readJsonReport(dir);
      const turn = data.turns.find(
        (t: any) => t.prompt.text === 'Build a retry helper for fetch.',
      );
      expect(turn).toBeDefined();
      // The planner's text reply was reconciled onto the turn.
      expect(turn.aiOutputs.map((o: any) => o.text)).toContain(
        'I added a retry helper and wired it in.',
      );
      // The generated plan(s) were captured.
      const planText = JSON.stringify(turn);
      expect(planText).toContain('fetchWithRetry');
    } finally {
      cleanup(dir);
      cleanup(geminiHome);
    }
  });
});
