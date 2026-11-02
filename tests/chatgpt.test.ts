import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'turbo-stream';
import { extractConversation, parseShareHtml } from '../src/core/chatgpt.ts';
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
            create_time: 1700000000,
            linear_conversation: [
              msg('sys', 'system', '', undefined, true), // hidden — skipped
              msg('u1', 'user', 'How do I reverse a string in Python?', 1700000100),
              msg('a1', 'assistant', 'Use slicing: s[::-1].', 1700000200),
              msg('u2', 'user', 'What are some project ideas to practice?', 1700000300),
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
    expect(c!.messages[0]!.createTime).toBe(1700000100);
  });
  test('parseShareHtml decodes the embedded turbo-stream payload', async () => {
    const c = await parseShareHtml(await shareHtml(payload()));
    expect(c.title).toBe('Reversing a string');
    expect(c.messages).toHaveLength(3);
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
