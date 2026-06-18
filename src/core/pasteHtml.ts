/**
 * Recover an exact conversation (with correct prompt/response roles) from the
 * HTML a browser puts on the clipboard when you copy a chat. ChatGPT tags every
 * turn with `data-message-author-role="user|assistant"`, so the roles are right
 * there in the markup — no guessing, no AI, no network. When the clipboard has
 * no such markup we return null and the caller falls back to plain-text parsing.
 */
import { sha256OfString } from './hash.ts';
import type { ParsedConversation, ParsedMessage } from './importCommon.ts';

/** Per-provider knobs for finding role-tagged turns in copied HTML. */
export interface HtmlParseConfig {
  /** Global regex whose first group captures the role at the start of each turn. */
  roleRe: RegExp;
  /** Map a captured marker to a normalized role, or null to skip the turn. */
  toRole: (captured: string) => 'user' | 'assistant' | null;
  title: string;
}

/** ChatGPT: each message container carries data-message-author-role. (Verified.) */
export const CHATGPT_HTML: HtmlParseConfig = {
  roleRe: /data-message-author-role="(user|assistant)"/gi,
  toRole: (c) => (c.toLowerCase() === 'assistant' ? 'assistant' : 'user'),
  title: 'ChatGPT conversation (pasted)',
};

/**
 * Gemini (best-effort): its copied DOM uses custom turn elements. We try those;
 * if they aren't present the parser returns null and the text fallback runs.
 */
export const GEMINI_HTML: HtmlParseConfig = {
  roleRe: /<(user-query|model-response)\b/gi,
  toRole: (c) => (/model/i.test(c) ? 'assistant' : 'user'),
  title: 'Gemini conversation (pasted)',
};

/** Pull the copied fragment out of the Windows CF_HTML envelope, if present. */
function fragment(html: string): string {
  const start = html.indexOf('<!--StartFragment-->');
  const end = html.indexOf('<!--EndFragment-->');
  if (start !== -1 && end !== -1 && end > start) {
    return html.slice(start + '<!--StartFragment-->'.length, end);
  }
  return html;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/** Decode the HTML entities that survive into text content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Reduce one turn's HTML to its readable text, dropping UI chrome. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Drop interactive chrome (Copy/Edit/Regenerate/Share/Download/reasoning toggles).
      .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      // Block boundaries become line breaks.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
      // Remaining complete tags, then any trailing partial tag at a turn boundary.
      .replace(/<[^>]+>/g, '')
      .replace(/<[^>]*$/, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build a message whose id is a content hash, so re-imports dedupe (mirrors importCommon). */
function htmlMessage(role: 'user' | 'assistant', text: string): ParsedMessage {
  return { id: 'paste:' + sha256OfString(role + '\n' + text).slice(0, 16), role, text };
}

/**
 * Parse copied conversation HTML into a normalized conversation with exact roles,
 * or null when no role markers are present (so the caller can fall back to text).
 */
export function parseConversationHtml(
  html: string,
  config: HtmlParseConfig,
): ParsedConversation | null {
  const frag = fragment(html);
  const markers = [...frag.matchAll(config.roleRe)];
  if (markers.length === 0) return null;

  const messages: ParsedMessage[] = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const role = config.toRole(m[1] ?? '');
    if (!role) continue;
    // Start at the end of this turn's opening tag; stop at the next turn's marker.
    const tagClose = frag.indexOf('>', (m.index ?? 0) + m[0].length);
    const start = tagClose === -1 ? (m.index ?? 0) + m[0].length : tagClose + 1;
    const end = i + 1 < markers.length ? (markers[i + 1]!.index ?? frag.length) : frag.length;
    const text = htmlToText(frag.slice(start, end));
    if (text) messages.push(htmlMessage(role, text));
  }

  if (messages.length === 0) return null;
  return { title: config.title, messages };
}
