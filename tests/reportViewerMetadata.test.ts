import { expect, test } from 'bun:test';
import { parityReportFixture } from '../scripts/acceptance/report-fixture.ts';
import { buildViewerPayload } from '../src/core/report/viewerPayload.ts';
import {
  decodeViewerHtml,
  renderViewerPayload,
  scanViewerHtml,
} from '../src/core/report/viewerCodec.ts';

test('plan identity aliases collapse capture duplicates without merging distinct equal-text proposals', () => {
  const data = parityReportFixture();
  const turn = data.turns[0]!;
  const original = turn.plans[0]!;
  turn.plans.push({ ...original, id: 'duplicate-plan-record' });
  data.plans.push({ ...data.plans[0]! });
  const built = buildViewerPayload(data);
  const plan = built.index.plans!.find((plan) => plan.id === original.id)!;
  expect(built.index.plans).toHaveLength(3);
  expect(plan.capturedRecords).toBe(2);
  expect(plan.aliases).toEqual(['duplicate-plan-record']);
  turn.plans.push({
    ...original,
    id: 'distinct-plan-record',
    sourceId: 'distinct-native-plan',
  });
  data.plans.push({ ...data.plans[0]! });
  expect(buildViewerPayload(data).index.plans).toHaveLength(4);
});

test('native plan bookkeeping remains inspectable without adding proposals to the plans index', () => {
  const data = parityReportFixture();
  data.turns[0]!.events.push({
    type: 'plan_snapshot',
    sequence: 21,
    sourceId: 'native-plan-approved:snapshot',
    plan: data.plans[0]!.text,
  });
  data.turns[0]!.events.push({
    type: 'plan_approved',
    sequence: 22,
    sourceId: 'another-provider-approval',
    plan: data.plans[0]!.text,
  });
  const built = buildViewerPayload(data);
  const decoded = decodeViewerHtml(renderViewerPayload(built.index, built.blocks))!;
  expect(built.index.plans).toHaveLength(3);
  expect([...decoded.texts.values()].join('\n')).toContain('another-provider-approval');
});

test('large numeric token counts pass inspection while credential strings in overview metadata stay blocked', () => {
  const data = parityReportFixture();
  data.turns[0]!.recap!.cacheReadTokens = 1_426_453_208;
  const built = buildViewerPayload(data);
  expect(scanViewerHtml(renderViewerPayload(built.index, built.blocks))).toEqual([]);
  const unsafe = {
    ...built.index,
    providerMetadata: {
      password: 123456789,
      inputTokens: 'api_key=deliberatelyFakeCredential123',
    },
  };
  expect(
    scanViewerHtml(renderViewerPayload(unsafe, built.blocks)).some(
      (finding) => finding.kind === 'assigned-secret',
    ),
  ).toBe(true);
});

test('every raw-result, recap and orphan-plan reference is checked before a report is trusted', () => {
  for (const mutate of [
    (index: any) => (index.turns[0].recapRef = 't999999'),
    (index: any) => (index.plans[0].textRef = 't999999'),
    (index: any) => (index.plans[0].rawRefs = ['t999999']),
    (index: any) => (index.plans[0].resultRef = 't999999'),
  ]) {
    const built = buildViewerPayload(parityReportFixture());
    mutate(built.index);
    expect(() =>
      decodeViewerHtml(renderViewerPayload(built.index, built.blocks)),
    ).toThrow();
  }
});

test('provider text-part identities do not repeat an identical reply but conflicting parts remain distinct', () => {
  const data = parityReportFixture();
  const turn = data.turns[0]!;
  turn.aiOutputs[0]!.sourceId = 'native-assistant-message';
  turn.events.push({
    type: 'assistant_text',
    sequence: 30,
    sourceId: 'native-assistant-message:text:0',
    text: turn.aiOutputs[0]!.text,
  });
  turn.events.push({
    type: 'assistant_text',
    sequence: 31,
    sourceId: 'native-assistant-message:text:0',
    text: 'Conflicting provider narration.',
  });
  const built = buildViewerPayload(data);
  const decoded = decodeViewerHtml(renderViewerPayload(built.index, built.blocks))!;
  const rows = decoded.structuredTexts.get(built.index.turns[0]!.itemsRef!) as any[];
  expect(rows.filter((item) => item.kind === 'ai')).toHaveLength(2);
  expect(built.index.aliases['native:parity-prompt-0:30']).toBe('parity-ai-0');
  expect(rows.find((item) => item.id === 'parity-ai-0').nativeEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceId: 'native-assistant-message:text:0' }),
    ]),
  );
  expect([...decoded.texts.values()].join('\n')).toContain(
    'Conflicting provider narration.',
  );
});

test('supplemental native user records stay inspectable without repeating the verified prompt in the reader', () => {
  const data = parityReportFixture();
  data.turns[0]!.events.push({
    type: 'user_text',
    sequence: 30,
    sourceId: 'provider-identity-for-legacy-ledger-input',
    text: data.turns[0]!.prompt.text,
  });
  const built = buildViewerPayload(data);
  const decoded = decodeViewerHtml(renderViewerPayload(built.index, built.blocks))!;
  const rows = decoded.structuredTexts.get(built.index.turns[0]!.itemsRef!) as any[];
  const native = rows.find(
    (item) => item.sourceId === 'provider-identity-for-legacy-ledger-input',
  );
  expect(native.nativeOnly).toBe(true);
  expect(decoded.texts.get(native.textRef)).toBe(data.turns[0]!.prompt.text);
  expect(built.index.turns).toHaveLength(data.turns.length);
});
