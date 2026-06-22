import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { renderPlanText, splitPlanText } from '../src/core/plans.ts';
import { readAllEvents } from '../src/core/events.ts';
import { buildReportData, renderHtml, renderMarkdown } from '../src/core/report.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

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

describe('plan import + report', () => {
  test('imports a plan event, tags it approved, and renders a collapsible block', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(
        fixture,
        planTranscript('# My Plan\n\nDo the thing.', APPROVED),
        'utf8',
      );
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });

      const plans = readAllEvents(paths).filter((e) => e.type === 'plan');
      expect(plans.length).toBe(1);
      expect(plans[0]!.tags).toContain('plan-approved');

      const data = buildReportData(paths);
      expect(data.summary.plans).toBe(1);

      const md = renderMarkdown(data);
      expect(md).toContain('📋 **Plan** · _approved_');
      expect(md).toContain('1 plan(s)'); // summary line

      const html = renderHtml(data);
      expect(html).toContain('<details class="plan">');
      expect(html).toContain('✅ Approved');
    } finally {
      cleanup(dir);
    }
  });

  test('a revised plan shows its feedback on the collapsed summary', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, planTranscript('# My Plan\n\nDo it.', REJECTED), 'utf8');
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });

      const plans = readAllEvents(paths).filter((e) => e.type === 'plan');
      expect(plans[0]!.tags).toContain('plan-revised');

      const html = renderHtml(buildReportData(paths));
      // The collapsed <summary> carries the badge AND the feedback message.
      const summary =
        /<details class="plan">\s*<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? '';
      expect(summary).toContain('↩ Revised');
      expect(summary).toContain('use approach B instead');
      // The "You sent this back asking:" prefix is split out, not rendered.
      expect(html).not.toContain('You sent this back asking');
      // The plan itself is still in the body.
      expect(html).toContain('My Plan');
    } finally {
      cleanup(dir);
    }
  });
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
