import { describe, expect, test } from 'bun:test';
import { CHATGPT_HTML, parseConversationHtml } from '../src/core/pasteHtml.ts';

// A trimmed copy of the CF_HTML a browser writes when you select+copy a ChatGPT
// conversation: each turn wrapped in a section with data-message-author-role, the
// message text in inner divs/paragraphs, and action buttons/svg as chrome.
const CHATGPT_CLIP = `Version:0.9
StartHTML:00000097
EndHTML:00000900
StartFragment:00000131
EndFragment:00000800
SourceURL:https://chatgpt.com/c/abc
<html><body>
<!--StartFragment--><section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="a"><div class="whitespace-pre-wrap">How do I reverse a list?</div></div></section><section data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="b"><div class="markdown"><p>Use <strong>list.reverse()</strong> &amp; reversed().</p></div><button type="button">Copy</button><button>Edit</button></div></section><section data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">And sorting?</div></div></section><section data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>Use sorted(list).</p></div><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><button>Good response</button></div></section><!--EndFragment-->
</body></html>`;

describe('parseConversationHtml', () => {
  test('recovers exact roles and text from copied ChatGPT HTML', () => {
    const conv = parseConversationHtml(CHATGPT_CLIP, CHATGPT_HTML);
    expect(conv).not.toBeNull();
    const msgs = conv!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[0]!.text).toBe('How do I reverse a list?');
    // Inline tags stripped, &amp; decoded, action buttons removed.
    expect(msgs[1]!.text).toBe('Use list.reverse() & reversed().');
    expect(msgs[2]!.text).toBe('And sorting?');
    expect(msgs[3]!.text).toBe('Use sorted(list).');
    const joined = msgs.map((m) => m.text).join('\n');
    expect(joined).not.toContain('Copy');
    expect(joined).not.toContain('Edit');
    expect(joined).not.toContain('Good response');
    expect(joined).not.toContain('<');
  });

  test('returns null when there are no role markers (plain text fallback)', () => {
    expect(parseConversationHtml('<html><body><p>just text</p></body></html>', CHATGPT_HTML)).toBeNull();
    expect(parseConversationHtml('not even html', CHATGPT_HTML)).toBeNull();
  });

  test('stable content-hash ids so re-imports dedupe', () => {
    const a = parseConversationHtml(CHATGPT_CLIP, CHATGPT_HTML)!;
    const b = parseConversationHtml(CHATGPT_CLIP, CHATGPT_HTML)!;
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
  });
});
