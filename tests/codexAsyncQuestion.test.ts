import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseCodexRollout, parseCodexTranscript } from '../src/core/codexTranscript.ts';
import {
  asyncReplyDecision,
  isNonBlockingDecisionText,
  parseAsyncQuestionReply,
  renderDecisionText,
} from '../src/core/decisions.ts';
import { renderHtml, renderMarkdown } from '../src/core/report.ts';
import { isSyntheticPrompt } from '../src/core/syntheticPrompt.ts';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';
/**
 * Codex's `request_user_input_async` doesn't pause the turn. The student's answer
 * comes back later as a synthetic user message wrapping a JSON array, and fires the
 * same UserPromptSubmit hook as a typed prompt. These pin that it is kept as a
 * student *decision* under the open prompt — never recorded as a prompt of its own.
 */
const CALL_ID = 'call_e29e652213e8483bb583e5db8a8b009e';
const QUESTION = 'Please check that the robot is on. Confirm when it is ready.';
const OPTIONS = ['Robot is on, ready', 'I need more time'];
/** The envelope exactly as Codex writes it (shape copied from a real rollout). */
function envelope(answer: string, question = QUESTION, callId = CALL_ID): string {
  return (
    '<send_user_message_question_reply>\n' +
    JSON.stringify([
      {
        answer,
        question,
        questionItemId: JSON.stringify(['request_user_input_async', callId, 0]),
      },
    ]) +
    '\n</send_user_message_question_reply>'
  );
}
// Isolate the machine-local ledger per test (see hook.test.ts).
let prevHome: string | undefined;
let home: string | undefined;
beforeEach(() => {
  prevHome = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  process.env.SHOWTAIL_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prevHome;
  if (home) cleanup(home);
});
describe('Codex non-blocking question helpers', () => {
  test('parses the reply envelope and the call id from questionItemId', () => {
    const replies = parseAsyncQuestionReply(envelope('Robot is on, ready'));
    expect(replies).toEqual([
      { question: QUESTION, answer: 'Robot is on, ready', callId: CALL_ID },
    ]);
  });
  test('anything else is not a reply: plain prompts, malformed JSON, wrong shape', () => {
    expect(parseAsyncQuestionReply('carry on')).toBeUndefined();
    expect(
      parseAsyncQuestionReply('mention <send_user_message_question_reply> inline'),
    ).toBeUndefined();
    expect(
      parseAsyncQuestionReply(
        '<send_user_message_question_reply>not json</send_user_message_question_reply>',
      ),
    ).toBeUndefined();
    expect(
      parseAsyncQuestionReply(
        '<send_user_message_question_reply>[{"nope":1}]</send_user_message_question_reply>',
      ),
    ).toBeUndefined();
  });
  test('a malformed envelope is still preserved as a decision, never dropped', () => {
    const raw =
      '<send_user_message_question_reply>not json</send_user_message_question_reply>';
    expect(asyncReplyDecision(raw)).toEqual({ text: raw });
    expect(asyncReplyDecision('carry on')).toBeUndefined();
  });
  test('a good envelope renders a non-blocking decision keyed by its call', () => {
    const d = asyncReplyDecision(envelope('Robot is on, ready'))!;
    expect(d.sourceId).toBe(`codex:decision:${CALL_ID}`);
    expect(d.text).toContain('**Codex asked (non-blocking):**');
    expect(d.text).toContain('**You answered:** Robot is on, ready');
    expect(isNonBlockingDecisionText(d.text)).toBe(true);
  });
  test('the envelope is "synthetic" so no prompt path can record it', () => {
    expect(isSyntheticPrompt(envelope('x'))).toBe(true);
    // A plain decision is not marked non-blocking.
    expect(
      isNonBlockingDecisionText(
        renderDecisionText([{ question: 'Q?', options: [], custom: false }], 'Claude'),
      ),
    ).toBe(false);
  });
});
describe('parseCodexTranscript: request_user_input_async', () => {
  /** A rollout in the shapes Codex writes: ask → accepted → work → synthetic reply. */
  function rollout(withCall = true): string {
    const lines: unknown[] = [
      { type: 'session_meta', payload: { id: 'sess-async', cwd: 'x' } },
      {
        timestamp: '2026-10-20T01:08:38.473Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input_async',
          call_id: CALL_ID,
          arguments: JSON.stringify({
            questions: [{ title: QUESTION, options: OPTIONS }],
          }),
        },
        metadata: { client_authored: false },
      },
      {
        timestamp: '2026-10-20T01:08:38.530Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: CALL_ID,
          output: '{"accepted":true}',
        },
      },
      {
        timestamp: '2026-10-20T01:10:43.376Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: envelope('Robot is on, ready') }],
        },
        metadata: { client_authored: false },
      },
    ];
    return (
      (withCall ? lines : lines.filter((_, i) => i !== 1 && i !== 2))
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );
  }
  test('emits the question at ask time and the answer at reply time, never a prompt', () => {
    const parsed = parseCodexTranscript(rollout(), 'x');
    expect(parsed.messages.filter((m) => m.role === 'user')).toHaveLength(0);
    const decisions = parsed.messages.filter((m) => m.role === 'decision');
    expect(decisions.map((d) => d.sourceId)).toEqual([
      `codex:decision-ask:${CALL_ID}`,
      `codex:decision:${CALL_ID}`,
    ]);
    // Terminal order: question when asked, answer when answered.
    expect(decisions[0]!.timestamp).toBe('2026-10-20T01:08:38.473Z');
    expect(decisions[1]!.timestamp).toBe('2026-10-20T01:10:43.376Z');
    const [ask, answer] = decisions;
    expect(isNonBlockingDecisionText(ask!.text)).toBe(true);
    expect(ask!.text).toContain(QUESTION);
    expect(ask!.text).toContain('- Robot is on, ready');
    expect(ask!.text).toContain('kept working while waiting');
    // The answer is rendered against the options Codex offered.
    expect(isNonBlockingDecisionText(answer!.text)).toBe(true);
    expect(answer!.text).toContain('- **Robot is on, ready** ✅ _(your choice)_');
    expect(answer!.text).toContain('- I need more time');
  });
  test('a reply whose call is not in the rollout still keeps the answer', () => {
    const parsed = parseCodexTranscript(rollout(false), 'x');
    const decisions = parsed.messages.filter((m) => m.role === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.sourceId).toBe(`codex:decision:${CALL_ID}`);
    expect(decisions[0]!.text).toContain('Robot is on, ready');
  });
  test('flows through the hook transcript with the same source ids', () => {
    const t = parseCodexRollout(rollout(), 'x');
    expect(
      t.messages.filter((m) => m.role === 'decision').map((m) => m.sourceId),
    ).toEqual([`codex:decision-ask:${CALL_ID}`, `codex:decision:${CALL_ID}`]);
  });
  test('other user-role response items stay dropped', () => {
    const content =
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions NOISE' }],
        },
      }) + '\n';
    expect(parseCodexTranscript(content, 'x').messages).toHaveLength(0);
  });
});
describe('live user-prompt hook', () => {
  function hook(dir: string, prompt: string) {
    return runCli(dir, ['hook', 'user-prompt', '--tool', 'codex'], {
      input: JSON.stringify({ cwd: dir, prompt, session_id: 'codex-sess-1' }),
    });
  }
});
describe('report', () => {});
