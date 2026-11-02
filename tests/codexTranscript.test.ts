import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexRollout, parseCodexTranscript } from '../src/core/codexTranscript.ts';
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
    // Per-turn context carries the active model, stamped onto the replies below.
    {
      timestamp: '2026-06-22T23:57:02.500Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.5', cwd: dir },
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
      // The edit's absolute envelope path is normalized to a repo-relative file,
      // and the apply_patch envelope becomes a CLEAN per-file diff (Claude-style
      // `+ ` lines, no `*** Begin Patch`/`@@`).
      const edit = parsed.messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['notes.txt']);
      expect(edit.edits).toHaveLength(1);
      expect(edit.edits![0]!.file).toBe('notes.txt');
      expect(edit.edits![0]!.diff).toContain('+ banana-codex');
      expect(edit.edits![0]!.diff).not.toContain('*** Begin Patch');
      // The reply is stamped with the model from the turn_context line.
      const reply = parsed.messages.find((m) => m.role === 'assistant')!;
      expect(reply.model).toBe('gpt-5.5');
      // The plan renders the steps as a status checklist, keyed by call_id.
      const plan = parsed.messages.find((m) => m.role === 'plan')!;
      expect(plan.sourceId).toBe('codex:plan:call_plan1');
      expect(plan.text).toContain('[x] Read notes.txt');
      expect(plan.text).toContain('[→] Rewrite the contents');
      expect(plan.text).toContain('[ ] Verify the change');
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_use' &&
            event.toolUseId === 'call_plan1' &&
            event.toolName === 'update_plan',
        ),
      ).toBe(true);
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_result' &&
            event.toolUseId === 'call_plan1' &&
            event.content === 'Plan updated',
        ),
      ).toBe(true);
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'plan_snapshot' &&
            event.plan?.includes('Rewrite the contents'),
        ),
      ).toBe(true);
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_use' &&
            event.toolUseId === 'call_abc' &&
            event.toolName === 'apply_patch',
        ),
      ).toBe(true);
      // Timestamps preserved for back-dating.
      expect(parsed.messages[0]!.timestamp).toBe('2026-06-22T23:57:04.000Z');
    } finally {
      cleanup(dir);
    }
  });
  test('parseCodexRollout keeps edits (with clean per-file diffs) + prompt/plan/reply', () => {
    const dir = makeTempDir();
    try {
      const t = parseCodexRollout(makeRollout(dir), dir);
      expect(t.sessionId).toBe('sess-codex-1');
      // Edits now flow through too (the reconcile imports their diffs).
      expect(t.messages.map((m) => m.role)).toEqual([
        'user',
        'plan',
        'edit',
        'assistant',
      ]);
      expect(t.messages[0]!.text).toContain('banana-codex');
      // The edit carries clean per-file diffs (no raw envelope).
      const edit = t.messages.find((m) => m.role === 'edit')!;
      expect(edit.edits?.[0]?.file).toBe('notes.txt');
      expect(edit.edits?.[0]?.diff).toContain('+ banana-codex');
      const plan = t.messages.find((m) => m.role === 'plan')!;
      expect(plan.text).toContain('Read notes.txt');
      // Codex plans are headless — never approved/revised, so they carry no
      // approval flag and the reconcile tags them with no badge.
      expect(plan.approved).toBeUndefined();
      expect(t.messages[t.messages.length - 1]!.text).toBe('Done.');
    } finally {
      cleanup(dir);
    }
  });
});
describe('parseCodexTranscript plans (item_completed/Plan)', () => {
  test('captures a completed Plan item as a plan message', () => {
    const lines: unknown[] = [
      { type: 'session_meta', payload: { id: 'sess-plan2', cwd: 'x' } },
      {
        timestamp: '2026-06-22T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'make a plan' },
      },
      {
        timestamp: '2026-06-22T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'Plan',
            id: 'sess-plan2-plan',
            text: '# Apples Plan\n\n## Summary\nUse apples.',
          },
        },
      },
    ];
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const parsed = parseCodexTranscript(content, 'x');
    const plan = parsed.messages.find((m) => m.role === 'plan')!;
    expect(plan).toBeDefined();
    expect(plan.sourceId).toBe('codex:plan:sess-plan2-plan');
    expect(plan.text).toContain('# Apples Plan');
  });
});
describe('parseCodexTranscript decisions (request_user_input)', () => {
  /** A rollout with one `request_user_input` and a matching answered output. */
  function decisionRollout(answeredOutput: string): string {
    const lines: unknown[] = [
      { type: 'session_meta', payload: { id: 'sess-dec', cwd: 'x' } },
      {
        timestamp: '2026-06-22T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'apples or bananas?' },
      },
      {
        timestamp: '2026-06-22T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'call_dec1',
          arguments: JSON.stringify({
            questions: [
              {
                id: 'fruit',
                header: 'Fruit',
                question: 'Are apples or bananas better?',
                options: [
                  { label: 'Apples', description: 'Pick apples.' },
                  { label: 'Bananas', description: 'Pick bananas.' },
                ],
              },
            ],
          }),
        },
      },
      {
        timestamp: '2026-06-22T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_dec1',
          output: answeredOutput,
        },
      },
    ];
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }
  test('captures an answered decision with the chosen option marked', () => {
    const content = decisionRollout(
      JSON.stringify({ answers: { fruit: { answers: ['Apples'] } } }),
    );
    const parsed = parseCodexTranscript(content, 'x');
    const decision = parsed.messages.find((m) => m.role === 'decision')!;
    expect(decision).toBeDefined();
    expect(decision.sourceId).toBe('codex:decision:call_dec1');
    expect(decision.timestamp).toBe('2026-06-22T10:00:01.000Z');
    expect(decision.text).toContain('**Codex asked:** Are apples or bananas better?');
    expect(decision.text).toContain('**Apples** ✅ _(your choice)_');
    expect(decision.text).toContain('- Bananas');
  });
  test('an unavailable picker still records the question, with no selection', () => {
    const content = decisionRollout('request_user_input is unavailable in Default mode');
    const parsed = parseCodexTranscript(content, 'x');
    const decision = parsed.messages.find((m) => m.role === 'decision')!;
    expect(decision).toBeDefined();
    expect(decision.text).toContain('Are apples or bananas better?');
    expect(decision.text).toContain('_(no option selected)_');
    expect(decision.text).not.toContain('✅');
  });
});
describe('codex getTranscript (stop reconcile)', () => {});
