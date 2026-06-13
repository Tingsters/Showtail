import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'turbo-stream';
import {
  extractConversation,
  importConversation,
  parseShareHtml,
} from '../src/core/chatgpt.ts';
import { readAllEvents } from '../src/core/events.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportChatgpt } from '../src/commands/import.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function msg(
  id: string,
  role: string,
  text: string,
  createTime?: number,
  hidden = false,
) {
  return {
    message: {
      id,
      author: { role, metadata: {} },
      content: { content_type: 'text', parts: [text] },
      ...(createTime ? { create_time: createTime } : {}),
      metadata: hidden ? { is_visually_hidden_from_conversation: true } : {},
    },
  };
}

/** A realistic decoded React-Router payload for a share page. */
function payload() {
  return {
    loaderData: {
      'routes/share.$shareId.($action)': {
        serverResponse: {
          data: {
            title: 'Reversing a string',
            conversation_id: 'conv-1',
            create_time: 1_700_000_000,
            linear_conversation: [
              msg('sys', 'system', '', undefined, true), // hidden — skipped
              msg('u1', 'user', 'How do I reverse a string in Python?', 1_700_000_100),
              msg('a1', 'assistant', 'Use slicing: s[::-1].', 1_700_000_200),
              msg(
                'u2',
                'user',
                'What are some project ideas to practice?',
                1_700_000_300,
              ),
            ],
          },
        },
      },
    },
  };
}

/** Encode a payload the way ChatGPT's page embeds it (turbo-stream inside enqueue("…")). */
async function shareHtml(value: unknown): Promise<string> {
  const encoded = await new Response(encode(value)).text();
  return `<!doctype html><html><body><script>
    window.__reactRouterContext.streamController.enqueue(${JSON.stringify(encoded)});
    window.__reactRouterContext.streamController.close();
  </script></body></html>`;
}

describe('chatgpt share import', () => {
  test('extractConversation pulls ordered, non-hidden messages with timestamps', () => {
    const c = extractConversation(payload());
    expect(c).not.toBeNull();
    expect(c!.title).toBe('Reversing a string');
    expect(c!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(c!.messages[0]!.text).toContain('reverse a string');
    expect(c!.messages[0]!.createTime).toBe(1_700_000_100);
  });

  test('parseShareHtml decodes the embedded turbo-stream payload', async () => {
    const c = await parseShareHtml(await shareHtml(payload()));
    expect(c.title).toBe('Reversing a string');
    expect(c.messages).toHaveLength(3);
  });

  test('import logs prompts (only) tagged chatgpt with original timestamps + sourceId', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const c = extractConversation(payload())!;

      const res = await importConversation(paths, c);
      expect(res.prompts).toBe(2);
      expect(res.responses).toBe(0);

      const prompts = readAllEvents(paths).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts.every((e) => e.tool === 'chatgpt')).toBe(true);
      expect(prompts[0]!.timestamp).toBe(new Date(1_700_000_100 * 1000).toISOString());
      expect(prompts[0]!.sourceId).toBe('u1');
    } finally {
      cleanup(dir);
    }
  });

  test('re-import is idempotent; --with-responses adds the assistant message', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const c = extractConversation(payload())!;

      await importConversation(paths, c);
      const again = await importConversation(paths, c);
      expect(again.prompts).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);

      const withResp = await importConversation(paths, c, { withResponses: true });
      expect(withResp.responses).toBe(1); // the one assistant message, newly added
      expect(readAllEvents(paths).some((e) => e.type === 'ai_output')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('runImportChatgpt works from a saved page via --file', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'saved.html');
      writeFileSync(file, await shareHtml(payload()), 'utf8');

      await runImportChatgpt(undefined, { file, cwd: dir });
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(2);
    } finally {
      cleanup(dir);
    }
  });

  test('a non-share URL is rejected with guidance', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      await expect(
        runImportChatgpt('https://example.com/not-a-share', { cwd: dir }),
      ).rejects.toThrow(/share URL/i);
    } finally {
      cleanup(dir);
    }
  });
});
