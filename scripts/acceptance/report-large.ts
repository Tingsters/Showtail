#!/usr/bin/env bun
/// <reference path="../../src/types/assets.d.ts" />
/** Deterministic large-report acceptance; no model calls or personal histories. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { renderHtml, renderMarkdown } from '../../src/core/report.ts';
import type { Event, ReportData, Turn, TurnCodeChange } from '../../src/types.ts';
import { inspectReport } from './report.ts';
import { parityReportFixture } from './report-fixture.ts';

export function largeReportFixture(): ReportData {
  const turns: Turn[] = [];
  const promptCount = 181,
    revisionCount = 4720;
  const stamp = (i: number, second = 0) =>
    new Date(Date.UTC(2026, 0, 1, 0, i, second)).toISOString();
  for (let i = 0; i < promptCount; i++) {
    const timestamp = stamp(i);
    const event = (id: string, type: Event['type'], text: string): Event => ({
      id,
      type,
      text,
      timestamp,
      actorSlug: 'fixture',
    });
    const byFile = new Map<string, TurnCodeChange>();
    const count =
      Math.floor(revisionCount / promptCount) + (i < revisionCount % promptCount ? 1 : 0);
    for (let j = 0; j < count; j++) {
      const path = `src/file-${j % 3}.ts`;
      let diff =
        `--- a/${path}\n+++ b/${path}\n@@ -1,90 +1,90 @@\n` +
        Array.from(
          { length: 90 },
          (_, line) =>
            `+export const fixture_${i}_${j}_${line} = "Complete captured revision ${i}, step ${j}, line ${line}.";`,
        ).join('\n');
      if (i === promptCount - 1 && j === count - 1) {
        const target = 32 * 1024 - 10;
        diff +=
          'q'.repeat(Math.max(0, target - Buffer.byteLength(diff))) +
          'SHOWTAIL_LATE_SEARCH_BOUNDARY_CANARY_4720\n+last revision retained';
      }
      const change = byFile.get(path) ?? {
        path,
        capturedOnly: true,
        timestamp: stamp(i, j),
        revisions: [],
      };
      change.revisions!.push({
        recordId: `revision-record-${i}-${j}`,
        timestamp: stamp(i, j),
        diff,
      });
      byFile.set(path, change);
    }
    turns.push({
      prompt: event(
        `prompt-${i}`,
        'prompt',
        i % 17 === 0
          ? 'Repeat this exact prompt.'
          : `Implement fixture step ${i}.\nPreserve all recorded work. <script> stays text; $& $\` $' stay literal.`,
      ),
      aiOutputs: [event(`ai-${i}`, 'ai_output', `Recorded response ${i}.`)],
      toolCalls:
        i === 0
          ? [
              event(
                'giant-tool',
                'tool_call',
                Array.from(
                  { length: 10000 },
                  (_, n) =>
                    `Native stdout line ${n}: this complete line remains available in bounded text pages.`,
                ).join('\n'),
              ),
            ]
          : [],
      decisions: [],
      plans: [],
      events: [],
      codeChanges: [...byFile.values()],
      tool: i % 2 ? 'claude' : 'codex',
      actorSlug: 'fixture',
      sessionId: `session-${i % 3}`,
    });
  }
  const rich = parityReportFixture();
  for (const turn of turns) {
    const ordinal = Number(turn.prompt.id.replace('prompt-', ''));
    turn.actorSlug = ordinal % 2 ? 'bob' : 'alice';
    for (const item of [turn.prompt, ...turn.aiOutputs, ...turn.toolCalls])
      item.actorSlug = turn.actorSlug;
    turn.prompt.model = ordinal % 2 ? 'claude-opus-4-8' : 'gpt-5.5';
    for (const ai of turn.aiOutputs) ai.model = turn.prompt.model;
  }
  for (const i of [0, 1]) {
    turns[i]!.plans = rich.turns[i]!.plans.map((plan) => ({
      ...plan,
      timestamp: stamp(i, 10),
    }));
    turns[i]!.recap = { ...rich.turns[i]!.recap!, timestamp: stamp(i, 45) };
  }
  turns[0]!.decisions = rich.turns[0]!.decisions.map((event) => ({
    ...event,
    timestamp: stamp(0, 2),
  }));
  turns[0]!.toolCalls.push(
    ...rich.turns[0]!.toolCalls.map((event, i) => ({
      ...event,
      timestamp: new Date(Date.parse(stamp(0)) + 100 + i * 10).toISOString(),
    })),
  );
  turns[0]!.events.push(
    ...rich.turns[0]!.events.map((event) => ({
      ...event,
      timestamp: new Date(Date.parse(stamp(0)) + 160).toISOString(),
    })),
  );
  turns[0]!.aiOutputs[0]!.text = rich.turns[0]!.aiOutputs[0]!.text;
  return {
    schemaVersion: 3,
    displayName: 'Large offline report acceptance',
    project: null,
    generatedAt: stamp(promptCount),
    scope: null,
    summary: {
      sessions: 3,
      events: promptCount * 2 + 1,
      artifacts: revisionCount,
      decisions: 1,
      plans: 3,
      stats: rich.summary.stats,
    },
    contributors: rich.contributors,
    tools: [],
    models: rich.models,
    toolTimeline: rich.toolTimeline,
    plans: rich.plans.map((plan, i) => ({
      ...plan,
      timestamp: stamp(i, i < 2 ? 10 : 0),
    })),
    turns,
    redactionCount: 3,
    coverage: rich.coverage,
    authorship: 'Synthetic acceptance fixture; no personal history.',
    fileObservations: [
      {
        recordId: 'workspace-observation',
        path: 'src/manual.ts',
        basis: 'workspace-delta',
        observedAt: stamp(promptCount),
        diff: '--- a/src/manual.ts\n+++ b/src/manual.ts\n+Observed workspace evidence\n',
      },
    ],
  };
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join('dist', 'acceptance', 'report-large'));
  mkdirSync(dir, { recursive: true });
  const data = largeReportFixture(),
    started = Date.now();
  const html = renderHtml(data);
  writeFileSync(join(dir, 'report.html'), html);
  writeFileSync(join(dir, 'report.md'), renderMarkdown(data));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(data));
  const generatedMs = Date.now() - started;
  const result = await inspectReport(
    join(dir, 'report.html'),
    join(dir, 'browser'),
    data.turns.map((turn) => turn.prompt.text),
  );
  result.checks.push({
    name: 'large fixture single HTML remains below twelve MiB',
    ok: Buffer.byteLength(html) <= 12 * 1024 * 1024,
    detail: `${Buffer.byteLength(html)} bytes; generated in ${generatedMs} ms.`,
  });
  result.checks.push({
    name: 'large fixture exercises full late-body search',
    ok: result.checks.some(
      (check) =>
        check.name === 'full-history search finds text beyond visible prompt previews' &&
        check.ok,
    ),
  });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        corpus: { prompts: data.turns.length, revisions: 4720 },
        generatedMs,
        htmlBytes: Buffer.byteLength(html),
        checks: result.checks,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    JSON.stringify(
      {
        artifactDir: dir,
        passed: result.checks.filter((check) => check.ok).length,
        failed: result.checks.filter((check) => !check.ok),
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = result.checks.some((check) => !check.ok) ? 1 : 0;
}
