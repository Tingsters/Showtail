import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import {
  materializePlan,
  MAX_PLAN_BYTES,
  renderPlanText,
  splitPlanText,
} from '../src/core/plans.ts';
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
      expect(md).toContain('1 plan'); // summary line

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

describe('materializePlan', () => {
  test('saves a browsable plans/<id>.md and returns its trail-relative path', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const { planPath } = materializePlan(paths, {
        text: '# Plan\n- do the thing',
        sourceId: 'ep1',
      });
      expect(planPath).toBe('plans/ep1.md');
      const file = join(paths.plansDir, 'ep1.md');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('do the thing');
    } finally {
      cleanup(dir);
    }
  });

  test('is idempotent for the same id+content and rewrites on change', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const file = join(paths.plansDir, 'ep1.md');
      materializePlan(paths, { text: 'v1', sourceId: 'ep1' });
      expect(readFileSync(file, 'utf8')).toBe('v1');
      // Same id, same content — still v1 (a no-op rewrite is fine).
      materializePlan(paths, { text: 'v1', sourceId: 'ep1' });
      expect(readFileSync(file, 'utf8')).toBe('v1');
      // Same id, changed content — overwritten.
      materializePlan(paths, { text: 'v2', sourceId: 'ep1' });
      expect(readFileSync(file, 'utf8')).toBe('v2');
    } finally {
      cleanup(dir);
    }
  });

  test('redacts secrets before writing the plan file', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const SECRET = 'AKIAIOSFODNN7EXAMPLE';
      const { planPath } = materializePlan(paths, {
        text: `# Plan\nuse token ${SECRET}`,
        sourceId: 'ep1',
      });
      const body = readFileSync(join(paths.base, planPath), 'utf8');
      expect(body).not.toContain(SECRET);
    } finally {
      cleanup(dir);
    }
  });

  test('caps an oversized plan', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const huge = 'x'.repeat(MAX_PLAN_BYTES + 5000);
      const { planPath } = materializePlan(paths, { text: huge, sourceId: 'big' });
      const body = readFileSync(join(paths.base, planPath), 'utf8');
      expect(body.length).toBeLessThan(huge.length);
      expect(body).toContain('plan truncated by Showtail');
    } finally {
      cleanup(dir);
    }
  });

  test('sanitizes ids containing : and / into a safe filename', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const { planPath } = materializePlan(paths, {
        text: 'plan',
        sourceId: 'agy-plan:abc/def',
      });
      expect(planPath).toBe('plans/agy-plan_abc_def.md');
      expect(existsSync(join(paths.plansDir, 'agy-plan_abc_def.md'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('plans as a first-class report item', () => {
  test('an imported plan is materialized and the report links to the plan file', async () => {
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

      // The plan event carries a planPath and the file exists on disk.
      const plans = readAllEvents(paths).filter((e) => e.type === 'plan');
      expect(plans[0]!.planPath).toBe('plans/ep1.md');
      expect(existsSync(join(paths.plansDir, 'ep1.md'))).toBe(true);

      // The report exposes a top-level Plans index with a working link.
      const data = buildReportData(paths);
      expect(data.plans.length).toBe(1);
      expect(data.plans[0]!.planPath).toBe('plans/ep1.md');
      expect(data.plans[0]!.status).toBe('approved');

      const md = renderMarkdown(data);
      expect(md).toContain('## Plans (1)');
      expect(md).toContain('[view plan file](../plans/ep1.md)');

      const html = renderHtml(data);
      // Top-level section link + the in-turn card link (which must not toggle the card).
      expect(html).toContain('../plans/ep1.md');
      expect(html).toContain('view plan file');
      expect(html).toContain('event.stopPropagation()');
    } finally {
      cleanup(dir);
    }
  });

  test('no Plans section renders when no plan was captured', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const data = buildReportData(paths);
      expect(data.plans).toEqual([]);
      expect(renderMarkdown(data)).not.toContain('## Plans');
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
