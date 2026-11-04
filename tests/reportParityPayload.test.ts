import { expect, test } from 'bun:test';
import {
  inspectEmbeddedContent,
  expectedUsage,
} from '../scripts/acceptance/report-content.ts';
import { parityReportFixture } from '../scripts/acceptance/report-fixture.ts';
import { renderHtml } from '../src/core/report.ts';

test('a rich report retains plans, orphan plans, measured usage, captured zero and source context', () => {
  const data = parityReportFixture();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(data),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(result.checks.filter((check) => !check.ok)).toEqual([]);
  expect(result.index.plans).toHaveLength(3);
  const orphan = result.index.plans!.find(
    (plan) => plan.title === 'Orphan migration plan',
  );
  expect(orphan).toBeDefined();
  expect(orphan?.turnId).toBeUndefined();
  expect(result.index.plans!.find((plan) => plan.status === 'revised')?.feedback).toBe(
    'Keep document scrolling; remove the nested panes.',
  );
});

test('usage oracle treats missing values and captured zeros as different evidence', () => {
  const data = parityReportFixture();
  expect(expectedUsage([data.turns[1]!])).toMatchObject({
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    durationCount: 1,
    tokenCount: 1,
  });
  expect(expectedUsage([data.turns[2]!])).toMatchObject({
    totalDurationMs: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    durationCount: 0,
    tokenCount: 0,
  });
});

test('plan oracle fails when a saved orphan plan disappears', () => {
  const data = parityReportFixture(),
    broken = structuredClone(data);
  broken.plans.pop();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded payload preserves every captured plan body, status and feedback including orphans',
    )?.ok,
  ).toBe(false);
});

test('plan oracle fails when revision feedback changes without changing the plan body', () => {
  const data = parityReportFixture(),
    broken = structuredClone(data);
  broken.plans[1]!.feedback = 'Incorrect feedback';
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded payload preserves every captured plan body, status and feedback including orphans',
    )?.ok,
  ).toBe(false);
});

test('plan oracle catches a lost distinct native plan even when its body and timestamp repeat', () => {
  const data = parityReportFixture();
  data.turns[0]!.plans.push({
    ...data.turns[0]!.plans[0]!,
    id: 'second-equal-plan',
    sourceId: 'second-native-plan',
  });
  data.plans.push({ ...data.plans[0]! });
  const good = inspectEmbeddedContent(
    data,
    renderHtml(data),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(good.index.plans).toHaveLength(4);
  const broken = structuredClone(data);
  broken.turns[0]!.plans.pop();
  broken.plans.pop();
  const result = inspectEmbeddedContent(
    data,
    renderHtml(broken),
    data.turns.map((turn) => turn.prompt.text),
  );
  expect(
    result.checks.find(
      (check) =>
        check.name ===
        'embedded plans retain display identities and justified capture aliases',
    )?.ok,
  ).toBe(false);
});
