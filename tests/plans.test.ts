import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { renderPlanText, splitPlanText } from '../src/core/plans.ts';
import { renderHtml, renderMarkdown } from '../src/core/report.ts';
import { cleanup, makeTempDir } from './helpers.ts';
import { HistoryStore } from '../src/core/history.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../src/core/plans.ts';
import { fixture } from './centralHelpers.ts';
import { readViewer } from './viewerHelpers.ts';
const APPROVED =
  'User has approved your plan. You can now start coding. Start with updating your todo list.';
const REJECTED =
  "The user doesn't want to proceed with this tool use. To tell you how to proceed, " +
  'the user said:\nuse approach B instead';
/** A transcript: a prompt, an `ExitPlanMode` plan, and its approval/rejection result. */
function planTranscript(plan: string, result: string): string {
  const lines: unknown[] = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-10T10:00:00.000Z',
      promptSource: 'typed',
      sessionId: 's1',
      message: { role: 'user', content: 'build a thing' },
    },
    {
      type: 'assistant',
      uuid: 'u2',
      timestamp: '2026-06-10T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'ep1', name: 'ExitPlanMode', input: { plan } }],
      },
    },
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-06-10T10:02:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ep1', content: result }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
describe('parseClaudeTranscript — plans', () => {
  test('captures an approved plan with its markdown', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(
        planTranscript('# My Plan\n\nDo the thing.', APPROVED),
        dir,
      );
      const plan = messages.find((m) => m.role === 'plan');
      expect(plan).toBeDefined();
      expect(plan!.sourceId).toBe('ep1');
      expect(plan!.approved).toBe(true);
      expect(plan!.text).toContain('# My Plan');
      expect(plan!.text).not.toContain('You sent this back asking');
    } finally {
      cleanup(dir);
    }
  });
  test('captures a revised plan and prepends the revision feedback', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(
        planTranscript('# My Plan\n\nDo the thing.', REJECTED),
        dir,
      );
      const plan = messages.find((m) => m.role === 'plan')!;
      expect(plan.approved).toBe(false);
      expect(plan.text).toContain(
        '**You sent this back asking:** use approach B instead',
      );
      expect(plan.text).toContain('# My Plan'); // the plan is still kept
    } finally {
      cleanup(dir);
    }
  });
});
describe('plan import + report', () => {});
describe('materializePlan', () => {});
describe('plans as a first-class report item', () => {
  test('the portable viewer retains approved and revised plans with exact feedback and literal code', () =>
    fixture(({ project }) => {
      using store = new HistoryStore();
      const session = store.ensureSession({ tool: 'claude-code', cwd: project });
      const prompt = store.append(session.id, {
        kind: 'prompt',
        text: 'Plan the change.',
        origin: 'human',
        ts: '2026-01-01T00:00:00.000Z',
      }).record!;
      const body = "# Plan\n\nKeep literal $& $' $` and </script> text.";
      const approved = store.append(session.id, {
        kind: 'plan',
        sourceId: 'approved-plan',
        text: body,
        tags: [PLAN_APPROVED_TAG],
        turnId: prompt.id,
        ts: '2026-01-01T00:00:01.000Z',
      }).record!;
      const revisedBody = renderPlanText(
        '# Revised plan',
        false,
        'Use the smaller approach.',
      );
      const revised = store.append(session.id, {
        kind: 'plan',
        sourceId: 'revised-plan',
        text: revisedBody,
        tags: [PLAN_REVISED_TAG],
        turnId: prompt.id,
        ts: '2026-01-01T00:00:02.000Z',
      }).record!;
      const data = buildHistoryReport(store, { kind: 'all' });
      const html = renderHtml(data);
      const { index, texts } = readViewer(html);
      expect(
        index.turns[0]!.itemIds.filter((id) => index.items[id]!.kind === 'plan'),
      ).toEqual([approved.id, revised.id]);
      expect(index.items[approved.id]!.tags).toContain(PLAN_APPROVED_TAG);
      expect(index.items[revised.id]!.tags).toContain(PLAN_REVISED_TAG);
      expect(texts.get(index.items[approved.id]!.textRef!)).toBe(body);
      expect(texts.get(index.items[revised.id]!.textRef!)).toBe('# Revised plan');
      expect(index.items[revised.id]!.feedback).toBe('Use the smaller approach.');
      expect(index.items[revised.id]!.rawRefs!.map((ref) => texts.get(ref))).toContain(
        revisedBody,
      );
      expect(html).not.toContain('and </script> text.');
      expect(data.plans).toHaveLength(2);
    }));
});
describe('splitPlanText', () => {
  test('is the inverse of renderPlanText', () => {
    const text = renderPlanText('# Plan body', false, 'change X to Y');
    expect(splitPlanText(text)).toEqual({
      feedback: 'change X to Y',
      plan: '# Plan body',
    });
    // Approved (no feedback) → no prefix, plan unchanged.
    expect(splitPlanText(renderPlanText('# Plan body', true))).toEqual({
      plan: '# Plan body',
    });
  });
});
