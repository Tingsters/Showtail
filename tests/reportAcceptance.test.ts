import { expect, test } from 'bun:test';
import { inspectEmbeddedContent } from '../scripts/acceptance/report-content.ts';
import { renderHtml } from '../src/core/report.ts';
import type { ReportData } from '../src/types.ts';

function sourceReport(): ReportData {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 3,
    displayName: 'Acceptance oracle regression',
    project: null,
    generatedAt: timestamp,
    scope: null,
    summary: { sessions: 1, events: 2, artifacts: 2, decisions: 0, plans: 0 },
    contributors: [],
    tools: [],
    models: [],
    toolTimeline: [],
    plans: [],
    redactionCount: 0,
    authorship: 'Fixture',
    turns: Array.from({ length: 2 }, (_, i) => ({
      prompt: {
        id: `prompt-${i}`,
        type: 'prompt',
        text: 'Same human prompt',
        timestamp,
        actorSlug: 'fixture',
      },
      actorSlug: 'fixture',
      tool: 'codex',
      sessionId: 'session',
      aiOutputs: [],
      toolCalls: [],
      decisions: [],
      plans: [],
      events: [],
      codeChanges: i
        ? []
        : [
            {
              path: 'same.ts',
              capturedOnly: true,
              timestamp,
              revisions: [
                {
                  recordId: 'revision:native-first',
                  timestamp,
                  diff: '--- a/same.ts\n+++ b/same.ts\n+first intermediate state\n',
                },
                {
                  recordId: 'second-revision',
                  timestamp,
                  diff: '--- a/same.ts\n+++ b/same.ts\n-first intermediate state\n+second state\n',
                },
              ],
            },
          ],
    })),
  };
}

test('the report acceptance oracle verifies complete repeated prompts and intermediate revisions', () => {
  const data = sourceReport();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(data),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(result.checks.every((check) => check.ok)).toBe(true);
});

test('the report acceptance oracle fails when a repeated human prompt disappears', () => {
  const data = sourceReport(),
    broken = structuredClone(data);
  broken.turns.pop();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded payload preserves every human prompt identity and exact text',
    )?.ok,
  ).toBe(false);
});

test('the report acceptance oracle fails when only the final same-file revision survives', () => {
  const data = sourceReport(),
    broken = structuredClone(data);
  broken.turns[0]!.codeChanges[0]!.revisions!.shift();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded payload preserves every revision identity, path and full diff',
    )?.ok,
  ).toBe(false);
});

test('the report acceptance oracle fails when revision identity remains but its diff changes', () => {
  const data = sourceReport(),
    broken = structuredClone(data);
  broken.turns[0]!.codeChanges[0]!.revisions![0]!.diff = '+wrong content';
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded payload preserves every revision identity, path and full diff',
    )?.ok,
  ).toBe(false);
});
