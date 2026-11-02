import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { parseShareHtml, parseTranscript, shareIdFromUrl } from '../src/core/gemini.ts';
import { renderMarkdown } from '../src/core/report.ts';
import { cleanup, makeTempDir } from './helpers.ts';
describe('gemini paste import', () => {
  test('parseTranscript splits user/assistant turns at You said:/Gemini said: markers', () => {
    const { conversation, markersFound } = parseTranscript(
      'You said:\nWrite a haiku about mountains\nGemini said:\nMist on the high peaks',
    );
    expect(markersFound).toBe(true);
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[0]!.text).toContain('haiku');
    expect(conversation.messages[1]!.text).toContain('Mist');
    expect(conversation.title).toBe('Gemini conversation (pasted)');
  });
  test('parseTranscript with no markers records every block as a student prompt', () => {
    const { conversation, markersFound } = parseTranscript(
      'First question about loops\n\nSecond question about recursion',
    );
    expect(markersFound).toBe(false);
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages.every((m) => m.role === 'user')).toBe(true);
  });
  test('parseShareHtml degrades to paste guidance when the format is unrecognized', async () => {
    await expect(
      parseShareHtml(
        '<!doctype html><html><body>no conversation data here</body></html>',
      ),
    ).rejects.toThrow(/--paste/);
  });
  // Wrap a payload the way Gemini's batchexecute endpoint does: the )]}' prefix,
  // a chunk-length line, then the ["wrb.fr","ujx1Bf",<payloadString>,…] entry.
  function rpcBody(payload: unknown): string {
    const entry = JSON.stringify([
      ['wrb.fr', 'ujx1Bf', JSON.stringify(payload), null, null, null, 'generic'],
    ]);
    return `)]}'\n\n${entry.length}\n${entry}\n`;
  }
  test('parseShareHtml decodes a batchexecute RPC body into paired turns', async () => {
    // Mirrors the real positional shape: payload[0][1]=turns, payload[0][2][1]=title;
    // per turn: [0][1]=r_id, [2][0][0]=user, [3][0][0][1][0]=model.
    const turn = [['c_x', 'r_1'], null, [['my question']], [[[null, ['the answer']]]]];
    const payload = [[null, [turn], [true, 'My Title\n']]];
    const conv = await parseShareHtml(rpcBody(payload));
    expect(conv.title).toBe('My Title');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.messages[0]!.text).toBe('my question');
    expect(conv.messages[1]!.text).toBe('the answer');
    expect(conv.messages[0]!.id).toBe('r_1');
    expect(conv.messages[1]!.id).toBe('r_1:r');
  });
  test('parseShareHtml keeps a user turn that has no model reply', async () => {
    // A turn with no model answer ([3] absent) yields a single user message.
    const turn = [['c_x', 'r_9'], null, [['just a question']], null];
    const payload = [[null, [turn], [true, 'T']]];
    const conv = await parseShareHtml(rpcBody(payload));
    expect(conv.messages.map((m) => m.role)).toEqual(['user']);
    expect(conv.messages[0]!.text).toBe('just a question');
  });
  test('shareIdFromUrl extracts the canonical id from share URLs (short links resolve at fetch)', () => {
    expect(shareIdFromUrl('https://gemini.google.com/share/87bdb8f6639c')).toBe(
      '87bdb8f6639c',
    );
    expect(shareIdFromUrl('https://gemini.google.com/share/46ec23aeb00e?skid=abc')).toBe(
      '46ec23aeb00e',
    );
    expect(shareIdFromUrl('https://g.co/gemini/share/76f6474922fc')).toBe('76f6474922fc');
    // Short share.gemini.google links carry a different token, resolved via redirect.
    expect(shareIdFromUrl('https://share.gemini.google/xK8SpLrNswyq')).toBeNull();
  });
  test('parseShareHtml degrades to paste guidance for an invalid/expired share', async () => {
    // Gemini returns a null payload slot for a share it can't find.
    const body = `)]}'\n\n40\n${JSON.stringify([
      ['wrb.fr', 'ujx1Bf', null, null, null, [5], 'generic'],
    ])}\n`;
    await expect(parseShareHtml(body)).rejects.toThrow(/--paste/);
  });
});
