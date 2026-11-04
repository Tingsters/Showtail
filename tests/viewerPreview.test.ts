import { expect, test } from 'bun:test';
import { preview, buildViewerPayload } from '../src/core/report/viewerPayload.ts';
import { decodeViewerHtml, renderViewerPayload } from '../src/core/report/viewerCodec.ts';
import { parityReportFixture } from '../scripts/acceptance/report-fixture.ts';

test('display previews mark truncation without cutting ordinary words or Unicode characters', () => {
  expect(preview('  short\n title  ', 20)).toBe('short title');
  expect(preview('one two three four five', 20)).toBe('one two three four…');
  expect(Array.from(preview('😀'.repeat(25), 20))).toHaveLength(20);
  expect(preview('x'.repeat(40), 20)).toBe('x'.repeat(19) + '…');
  expect(preview('short', 5)).toBe('short');
  const family = '👩‍👩‍👧‍👦';
  expect(preview(family.repeat(30), 5)).toBe(family.repeat(4) + '…');
  expect(preview('x'.repeat(5_000_000), 20)).toBe('x'.repeat(19) + '…');
});

test('shortened exchange and session labels preserve complete captured prompts and identities', () => {
  const data = parityReportFixture();
  const prompt = 'An ordinary long request with readable words and 😀 emoji. '.repeat(10);
  data.turns[0]!.prompt.text = prompt;
  data.turns[1]!.prompt.text = prompt;
  const payload = buildViewerPayload(data);
  const first = payload.index.turns[0]!;
  expect(first.preview.endsWith('…')).toBe(true);
  expect(
    payload.index
      .sessions!.find((session) => session.id === first.sessionId)!
      .label.endsWith('…'),
  ).toBe(true);
  expect(payload.index.turns[1]!.id).not.toBe(first.id);
  const decoded = decodeViewerHtml(renderViewerPayload(payload.index, payload.blocks))!;
  expect(decoded.texts.get(first.promptRef!)).toBe(prompt);
});
