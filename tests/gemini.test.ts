import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  importConversation,
  parseShareHtml,
  parseTranscript,
  shareIdFromUrl,
} from '../src/core/gemini.ts';
import { buildReportData, renderMarkdown } from '../src/core/report.ts';
import { readAllEvents } from '../src/core/events.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportGemini } from '../src/commands/importGemini.ts';
import { pathsForRoot } from '../src/core/storage.ts';
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

  test('importConversation logs prompts tagged google-gemini; dedupes on re-import', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const { conversation } = parseTranscript(
        'You said:\nQ1\nGemini said:\nA1\nYou said:\nQ2',
      );

      const res = await importConversation(paths, conversation, 'google-gemini');
      expect(res.prompts).toBe(2);
      expect(res.responses).toBe(0);

      const prompts = readAllEvents(paths).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts.every((e) => e.tool === 'google-gemini')).toBe(true);

      const again = await importConversation(paths, conversation, 'google-gemini');
      expect(again.prompts).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);

      const withResp = await importConversation(paths, conversation, 'google-gemini', {
        withResponses: true,
      });
      expect(withResp.responses).toBe(1);
      expect(readAllEvents(paths).some((e) => e.type === 'ai_output')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('runImportGemini records a pasted transcript and --date places it on the timeline', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      await runImportGemini(undefined, {
        text: 'You said:\nExplain closures\nGemini said:\nA closure captures its scope.',
        withResponses: true,
        date: '2026-06-10',
        cwd: dir,
      });

      const events = readAllEvents(pathsForRoot(dir));
      const prompts = events.filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.tool).toBe('google-gemini');
      expect(prompts[0]!.timestamp.startsWith('2026-06-10')).toBe(true);
      expect(events.some((e) => e.type === 'ai_output')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('runImportGemini works from a saved transcript via --file', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'transcript.txt');
      writeFileSync(file, 'You said:\nQ1\nGemini said:\nA1', 'utf8');

      await runImportGemini(undefined, { file, cwd: dir });
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('a non-share URL is rejected with guidance', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      await expect(
        runImportGemini('https://example.com/not-a-share', { cwd: dir }),
      ).rejects.toThrow(/share URL/i);
    } finally {
      cleanup(dir);
    }
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

  test('imported gemini events appear in the report (prompts + tool)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const { conversation } = parseTranscript('You said:\nQ about arrays');
      await importConversation(paths, conversation, 'google-gemini');

      const md = renderMarkdown(buildReportData(paths));
      expect(md).toContain('Q about arrays');
      expect(md).toContain('Google Gemini');
    } finally {
      cleanup(dir);
    }
  });
});
