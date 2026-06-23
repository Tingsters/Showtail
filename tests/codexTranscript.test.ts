import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexRollout, parseCodexTranscript } from '../src/core/codexTranscript.ts';
import { readAllEvents } from '../src/core/events.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';

/** Run `showtail <args>` in `cwd`, optionally piping `input` to stdin. */
function run(cwd: string, args: string[], input?: string) {
  return runCli(cwd, args, { input });
}

/**
 * Build a synthetic Codex rollout (one JSON object per line) mixing the line
 * shapes we keep — `session_meta`, `event_msg`/`user_message`,
 * `event_msg`/`agent_message`, `response_item`/`custom_tool_call`(apply_patch) —
 * with the wrapped/duplicate noise we must drop (`response_item`/`message`,
 * developer chrome, reasoning, token_count).
 */
function makeRollout(dir: string): string {
  const lines: unknown[] = [
    {
      timestamp: '2026-06-22T23:57:01.000Z',
      type: 'session_meta',
      payload: { id: 'sess-codex-1', cwd: dir, cli_version: '0.141.0' },
    },
    {
      timestamp: '2026-06-22T23:57:02.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    },
    // The wrapped duplicate prompt (AGENTS.md/developer chrome) — must be dropped.
    {
      timestamp: '2026-06-22T23:57:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions ... NOISE' }],
      },
    },
    // The clean typed prompt — kept.
    {
      timestamp: '2026-06-22T23:57:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Edit notes.txt so its contents become banana-codex.',
      },
    },
    // Model reasoning — dropped.
    {
      timestamp: '2026-06-22T23:57:05.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [] },
    },
    // Codex's update_plan tool — a plan/todo list. `arguments` is a JSON string.
    {
      timestamp: '2026-06-22T23:57:05.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'call_plan1',
        arguments: JSON.stringify({
          plan: [
            { step: 'Read notes.txt', status: 'completed' },
            { step: 'Rewrite the contents', status: 'in_progress' },
            { step: 'Verify the change', status: 'pending' },
          ],
        }),
      },
    },
    // The plan's result line — a bare "Plan updated" (no approval). Ignored.
    {
      timestamp: '2026-06-22T23:57:05.600Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_plan1',
        output: 'Plan updated',
      },
    },
    // The edit via apply_patch — kept (in-repo file).
    {
      timestamp: '2026-06-22T23:57:06.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call_abc',
        name: 'apply_patch',
        input:
          '*** Begin Patch\n*** Update File: ' +
          join(dir, 'notes.txt') +
          '\n@@\n-old\n+banana-codex\n*** End Patch\n',
      },
    },
    // An edit to an internal .codex file — dropped.
    {
      timestamp: '2026-06-22T23:57:06.500Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_internal',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: .codex/config.toml\n*** End Patch\n',
      },
    },
    {
      timestamp: '2026-06-22T23:57:07.000Z',
      type: 'event_msg',
      payload: { type: 'token_count' },
    },
    // The clean assistant reply — kept.
    {
      timestamp: '2026-06-22T23:57:08.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    },
    // The wrapped duplicate assistant message — dropped.
    {
      timestamp: '2026-06-22T23:57:09.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      },
    },
    {
      timestamp: '2026-06-22T23:57:10.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseCodexTranscript', () => {
  test('keeps prompt, assistant reply and the repo edit; drops the noise', () => {
    const dir = makeTempDir();
    try {
      const parsed = parseCodexTranscript(makeRollout(dir), dir);
      expect(parsed.sessionId).toBe('sess-codex-1');

      const roles = parsed.messages.map((m) => m.role);
      expect(roles.filter((r) => r === 'user').length).toBe(1);
      expect(roles.filter((r) => r === 'assistant').length).toBe(1);
      expect(roles.filter((r) => r === 'edit').length).toBe(1);
      expect(roles.filter((r) => r === 'plan').length).toBe(1);

      const blob = parsed.messages.map((m) => m.text).join('\n');
      expect(blob).not.toContain('AGENTS.md');
      expect(blob).not.toContain('config.toml');

      // The edit's absolute envelope path is normalized to a repo-relative file.
      const edit = parsed.messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['notes.txt']);

      // The plan renders the steps as a status checklist, keyed by call_id.
      const plan = parsed.messages.find((m) => m.role === 'plan')!;
      expect(plan.sourceId).toBe('codex:plan:call_plan1');
      expect(plan.text).toContain('[x] Read notes.txt');
      expect(plan.text).toContain('[→] Rewrite the contents');
      expect(plan.text).toContain('[ ] Verify the change');

      // Timestamps preserved for back-dating.
      expect(parsed.messages[0]!.timestamp).toBe('2026-06-22T23:57:04.000Z');
    } finally {
      cleanup(dir);
    }
  });

  test('parseCodexRollout drops edits, keeping prompt/plan/reply', () => {
    const dir = makeTempDir();
    try {
      const t = parseCodexRollout(makeRollout(dir), dir);
      expect(t.sessionId).toBe('sess-codex-1');
      // The plan flows through (between prompt and reply); the edit is dropped.
      expect(t.messages.map((m) => m.role)).toEqual(['user', 'plan', 'assistant']);
      expect(t.messages[0]!.text).toContain('banana-codex');
      const plan = t.messages.find((m) => m.role === 'plan')!;
      expect(plan.text).toContain('Read notes.txt');
      // Codex plans are headless — always marked approved for the reconcile.
      expect(plan.approved).toBe(true);
      expect(t.messages[t.messages.length - 1]!.text).toBe('Done.');
    } finally {
      cleanup(dir);
    }
  });
});

describe('apply_patch absolute-path capture (regression)', () => {
  test('a post-edit apply_patch payload with an ABSOLUTE path produces an artifact', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init', '--project', 'Codex Abs Path']);
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;');

      // The real Codex bug: the envelope carries an ABSOLUTE file path. Before the
      // fix this passed straight through and the snapshot silently failed.
      const payload = JSON.stringify({
        cwd: dir,
        tool_name: 'apply_patch',
        tool_input: {
          input:
            '*** Begin Patch\n*** Update File: ' +
            join(dir, 'parser.ts') +
            '\n@@\n-1\n+2\n*** End Patch',
        },
      });
      const r = run(dir, ['hook', 'post-edit', '--tool', 'codex'], payload);
      expect(r.code).toBe(0);

      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
      expect(data.artifacts[0].tool).toBe('codex');
    } finally {
      cleanup(dir);
    }
  });
});

describe('codex getTranscript (stop reconcile)', () => {
  test('locates the session rollout by id and back-fills the reply', () => {
    const dir = makeTempDir();
    const codexHome = makeTempDir();
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      run(dir, ['init', '--project', 'Codex Stop']);
      // Place a rollout where Codex would, named with the session id, recording
      // a prompt + reply for this project (cwd === dir).
      const day = join(codexHome, 'sessions', '2026', '06', '22');
      run(dir, ['hook', 'session-start']); // ensure project is set up
      // Write the rollout file directly.
      const rolloutName =
        'rollout-2026-06-22T23-57-00-019ef1c4-1899-7a90-bb9f-b09bca10e91c.jsonl';
      const sid = '019ef1c4-1899-7a90-bb9f-b09bca10e91c';
      const lines = [
        { type: 'session_meta', payload: { id: sid, cwd: dir } },
        {
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'add a retry to fetch' },
        },
        {
          timestamp: new Date(Date.now() + 2000).toISOString(),
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Added retry to fetch.' },
        },
      ];
      // mkdir + write the rollout
      const { mkdirSync, writeFileSync: wf } = require('node:fs');
      mkdirSync(day, { recursive: true });
      wf(join(day, rolloutName), lines.map((l: unknown) => JSON.stringify(l)).join('\n'));

      // Stop, identifying the session by id; getTranscript finds the rollout.
      run(
        dir,
        ['hook', 'stop', '--tool', 'codex'],
        JSON.stringify({ cwd: dir, session_id: sid }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const turn = data.turns.find((t: any) => t.prompt.text === 'add a retry to fetch');
      expect(turn).toBeDefined();
      expect(turn.aiOutputs.map((o: any) => o.text)).toEqual(['Added retry to fetch.']);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      cleanup(dir);
      cleanup(codexHome);
    }
  });

  test('reconciles an update_plan into an approved plan event', () => {
    const dir = makeTempDir();
    const codexHome = makeTempDir();
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      run(dir, ['init', '--project', 'Codex Plan Stop']);
      run(dir, ['hook', 'session-start']);

      const day = join(codexHome, 'sessions', '2026', '06', '22');
      const rolloutName =
        'rollout-2026-06-22T23-58-00-019ef1c4-1899-7a90-bb9f-b09bca10e92d.jsonl';
      const sid = '019ef1c4-1899-7a90-bb9f-b09bca10e92d';
      const lines = [
        { type: 'session_meta', payload: { id: sid, cwd: dir } },
        {
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'build a hello world script' },
        },
        // Codex's plan/todo list (update_plan); arguments is a JSON string.
        {
          timestamp: new Date(Date.now() + 2000).toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call_planA',
            arguments: JSON.stringify({
              plan: [
                { step: 'Pick a language', status: 'completed' },
                { step: 'Write the script', status: 'in_progress' },
              ],
            }),
          },
        },
        {
          timestamp: new Date(Date.now() + 3000).toISOString(),
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Done.' },
        },
      ];
      const { mkdirSync, writeFileSync: wf } = require('node:fs');
      mkdirSync(day, { recursive: true });
      wf(join(day, rolloutName), lines.map((l: unknown) => JSON.stringify(l)).join('\n'));

      run(
        dir,
        ['hook', 'stop', '--tool', 'codex'],
        JSON.stringify({ cwd: dir, session_id: sid }),
      );

      const paths = pathsForRoot(dir);
      const plans = readAllEvents(paths).filter((e) => e.type === 'plan');
      expect(plans.length).toBe(1);
      expect(plans[0]!.tool).toBe('codex');
      expect(plans[0]!.tags).toContain('plan-approved');
      expect(plans[0]!.text).toContain('Pick a language');
      expect(plans[0]!.text).toContain('Write the script');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      cleanup(dir);
      cleanup(codexHome);
    }
  });
});
