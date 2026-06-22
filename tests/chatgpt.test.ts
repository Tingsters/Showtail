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
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

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
      const author = authorFor(paths);
      const c = extractConversation(payload())!;

      const res = await importConversation(author, c, 'chatgpt');
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
      const author = authorFor(paths);
      const c = extractConversation(payload())!;

      await importConversation(author, c, 'chatgpt');
      const again = await importConversation(author, c, 'chatgpt');
      expect(again.prompts).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);

      const withResp = await importConversation(author, c, 'chatgpt', {
        withResponses: true,
      });
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

describe('chatgpt parsing edge cases', () => {
  test('parseShareHtml throws clear guidance when the page has no embedded data', async () => {
    await expect(
      parseShareHtml('<!doctype html><html><body>no stream here</body></html>'),
    ).rejects.toThrow(/conversation data/);
  });

  test('extractConversation returns null when no conversation is present', () => {
    expect(extractConversation(null)).toBeNull();
    expect(extractConversation({})).toBeNull();
    expect(extractConversation({ loaderData: {} })).toBeNull();
  });

  test('extractConversation reads a `mapping` graph from a root, in order', () => {
    // No loaderData → the decoded object itself is the bucket; `data` holds the
    // conversation. Exercises the mapping-graph path (no linear_conversation).
    const conv = extractConversation({
      data: {
        title: 'Mapped chat',
        conversation_id: 'c-map',
        mapping: {
          root: { children: ['u1'] },
          u1: {
            parent: 'root',
            children: ['a1'],
            message: { id: 'u1', author: { role: 'user' }, content: { parts: ['Q1'] } },
          },
          a1: {
            parent: 'u1',
            children: [],
            message: {
              id: 'a1',
              author: { role: 'assistant' },
              content: { parts: ['A1'] },
            },
          },
        },
      },
    });
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe('Mapped chat');
    expect(conv!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv!.messages.map((m) => m.text)).toEqual(['Q1', 'A1']);
  });

  test('extractConversation orders a rootless `mapping` by create_time', () => {
    const conv = extractConversation({
      serverResponse: {
        data: {
          mapping: {
            a1: {
              parent: 'x',
              message: {
                id: 'a1',
                author: { role: 'assistant' },
                content: { parts: ['second'] },
                create_time: 200,
              },
            },
            u1: {
              parent: 'x',
              message: {
                id: 'u1',
                author: { role: 'user' },
                content: { parts: ['first'] },
                create_time: 100,
              },
            },
          },
        },
      },
    });
    expect(conv!.messages.map((m) => m.text)).toEqual(['first', 'second']);
  });

  test('skips tool-directed messages and reads the `text` content fallback', () => {
    const conv = extractConversation({
      data: {
        linear_conversation: [
          // recipient !== 'all' → an internal tool turn, skipped.
          {
            message: {
              id: 't',
              author: { role: 'assistant' },
              recipient: 'web',
              content: { parts: ['search query'] },
            },
          },
          // No `parts` → the `content.text` fallback is used.
          {
            message: {
              id: 'u',
              author: { role: 'user' },
              content: { text: 'from the text field' },
            },
          },
        ],
      },
    });
    expect(conv!.messages.map((m) => m.text)).toEqual(['from the text field']);
  });
});
