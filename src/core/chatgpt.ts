import { decode } from 'turbo-stream';
import { asArray, asNumber, asString, isObject, prop } from './parse.ts';
import {
  parseTranscript as parseTranscriptShared,
  type ParsedConversation,
  type ParsedMessage,
  type TranscriptParseOptions,
  type TranscriptResult,
} from './importCommon.ts';

// The generic import machinery lives in importCommon.ts. Re-export the parts
// callers historically imported from here so existing imports keep working.
export {
  importConversation,
  type ParsedConversation,
  type ParsedMessage,
  type TranscriptResult,
  type ImportOptions,
  type ImportResult,
} from './importCommon.ts';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Fetch a public ChatGPT share page (a browser UA is required, or it 403s). */
export async function fetchSharedConversation(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) {
    throw new Error(
      `Could not fetch the share link (HTTP ${res.status}). Check the URL, or save the ` +
        `page and pass it with --file.`,
    );
  }
  return res.text();
}

/**
 * Parse a ChatGPT share page. The conversation is embedded as a React Router v7
 * turbo-stream payload inside `streamController.enqueue("…")` chunks; we decode
 * it (turbo-stream v2, which React Router bundles) and pull out the messages.
 */
export async function parseShareHtml(html: string): Promise<ParsedConversation> {
  const chunks = extractEnqueuedChunks(html);
  if (chunks.length === 0) {
    throw new Error(
      'Could not find the conversation data in the page — the ChatGPT share format may have ' +
        'changed. Try the data-export import, or report this.',
    );
  }

  let decoded: unknown;
  try {
    decoded = await decodeChunks(chunks);
  } catch (err) {
    throw new Error(
      `Could not decode the shared conversation: ${(err as Error).message}`,
    );
  }

  const conversation = extractConversation(decoded);
  if (!conversation) {
    throw new Error(
      'Decoded the page but could not locate the conversation — the ChatGPT share format may ' +
        'have changed.',
    );
  }
  return conversation;
}

/** Pull the `streamController.enqueue("…")` string literals out of the HTML, in order. */
function extractEnqueuedChunks(html: string): string[] {
  const re = /enqueue\("((?:[^"\\]|\\.)*)"\)/g;
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      // Skip a chunk we can't unescape rather than failing the whole import.
    }
  }
  return out;
}

async function decodeChunks(chunks: string[]): Promise<unknown> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  const result = (await decode(stream)) as { value?: unknown; done?: Promise<void> };
  if (result?.done) await result.done.catch(() => {});
  return result?.value ?? result;
}

/** Navigate the decoded React Router (share-page) payload to the conversation. */
export function extractConversation(decoded: unknown): ParsedConversation | null {
  const data = findConversationData(decoded);
  return data ? conversationFromData(data) : null;
}

/**
 * Turn a conversation object into a normalized conversation. Handles both the
 * `linear_conversation` array and the `mapping` graph shapes ChatGPT uses.
 */
function conversationFromData(data: unknown): ParsedConversation {
  const mapping = prop(data, 'mapping');
  const nodes: unknown[] =
    asArray(prop(data, 'linear_conversation')) ??
    (mapping ? orderedFromMapping(mapping) : []);

  const messages: ParsedMessage[] = [];
  for (const node of nodes) {
    const msg = prop(node, 'message');
    if (!isObject(msg)) continue;
    if (prop(prop(msg, 'metadata'), 'is_visually_hidden_from_conversation')) continue;
    // Skip tool-directed messages (e.g. ChatGPT's internal web-search queries):
    // real user/assistant turns are addressed to "all".
    const recipient = prop(msg, 'recipient');
    if (typeof recipient === 'string' && recipient !== 'all') continue;
    const role = asString(prop(prop(msg, 'author'), 'role'));
    if (role === undefined) continue;
    const text = extractText(prop(msg, 'content'));
    if (!text.trim()) continue;
    messages.push({
      id: asString(prop(msg, 'id')) ?? '',
      role,
      text,
      createTime: asNumber(prop(msg, 'create_time')),
    });
  }

  const title = asString(prop(data, 'title'));
  return {
    id: asString(prop(data, 'conversation_id')) ?? asString(prop(data, 'id')),
    title: title ? title : 'ChatGPT conversation',
    messages,
  };
}

/** Find the `serverResponse.data` object holding the conversation, by shape (route-key agnostic). */
function findConversationData(decoded: unknown): unknown {
  const ld = prop(decoded, 'loaderData');
  const buckets = isObject(ld) ? Object.values(ld) : [decoded];
  for (const b of buckets) {
    const data = prop(prop(b, 'serverResponse'), 'data') ?? prop(b, 'data') ?? b;
    if (isObject(data) && (prop(data, 'linear_conversation') || prop(data, 'mapping'))) {
      return data;
    }
  }
  return null;
}

/** Reconstruct message order from a `mapping` graph (fallback when no linear_conversation). */
function orderedFromMapping(mapping: unknown): unknown[] {
  if (!isObject(mapping)) return [];
  const nodes = Object.values(mapping);
  const root = nodes.find((n) => !prop(n, 'parent'));
  if (!root) {
    return nodes
      .filter((n) => prop(n, 'message'))
      .sort(
        (a, b) =>
          (asNumber(prop(prop(a, 'message'), 'create_time')) ?? 0) -
          (asNumber(prop(prop(b, 'message'), 'create_time')) ?? 0),
      );
  }
  const ordered: unknown[] = [];
  let cur: unknown = root;
  const seen = new Set<string>();
  while (cur) {
    if (prop(cur, 'message')) ordered.push(cur);
    const childId = asString(prop(prop(cur, 'children'), '0'));
    if (!childId || seen.has(childId)) break;
    seen.add(childId);
    cur = mapping[childId];
  }
  return ordered;
}

function extractText(content: unknown): string {
  if (!content) return '';
  const parts = asArray(prop(content, 'parts'));
  if (parts) {
    return parts
      .map((p) => asString(p) ?? asString(prop(p, 'text')) ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return asString(prop(content, 'text')) ?? '';
}

// --- Manual paste / backup import -----------------------------------------

/** Role markers ChatGPT page-copies sometimes include (accessibility headings + labels). */
const ROLE_RE =
  /(You said:|ChatGPT said:|(?:^|\n)[ \t]*(?:You|User|ChatGPT|Assistant):)/gi;

/** ChatGPT-specific knobs for the shared transcript parser. */
export const CHATGPT_TRANSCRIPT: TranscriptParseOptions = {
  roleRe: ROLE_RE,
  assistantTest: /chatgpt|assistant/i,
  title: 'ChatGPT conversation (pasted)',
};

/** Parse a pasted ChatGPT transcript (thin wrapper over the shared parser). */
export function parseTranscript(input: string): TranscriptResult {
  return parseTranscriptShared(input, CHATGPT_TRANSCRIPT);
}
