import { decode } from 'turbo-stream';
import { logEvent, importedSourceIds } from './events.ts';
import type { ShowtailPaths } from './storage.ts';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface ParsedMessage {
  id: string;
  role: string; // user | assistant | system | tool
  text: string;
  /** Epoch seconds, when present. */
  createTime?: number;
}

export interface ParsedConversation {
  id?: string;
  title: string;
  messages: ParsedMessage[];
}

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
function conversationFromData(data: any): ParsedConversation {
  const nodes: unknown[] = Array.isArray(data.linear_conversation)
    ? data.linear_conversation
    : data.mapping
      ? orderedFromMapping(data.mapping)
      : [];

  const messages: ParsedMessage[] = [];
  for (const node of nodes) {
    const msg = (node as { message?: any })?.message;
    if (!msg || typeof msg !== 'object') continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    // Skip tool-directed messages (e.g. ChatGPT's internal web-search queries):
    // real user/assistant turns are addressed to "all".
    if (typeof msg.recipient === 'string' && msg.recipient !== 'all') continue;
    const role = msg.author?.role;
    if (typeof role !== 'string') continue;
    const text = extractText(msg.content);
    if (!text.trim()) continue;
    messages.push({
      id: typeof msg.id === 'string' ? msg.id : '',
      role,
      text,
      createTime: typeof msg.create_time === 'number' ? msg.create_time : undefined,
    });
  }

  return {
    id:
      typeof data.conversation_id === 'string'
        ? data.conversation_id
        : typeof data.id === 'string'
          ? data.id
          : undefined,
    title:
      typeof data.title === 'string' && data.title ? data.title : 'ChatGPT conversation',
    messages,
  };
}

/** Find the `serverResponse.data` object holding the conversation, by shape (route-key agnostic). */
function findConversationData(decoded: unknown): any | null {
  const ld = (decoded as any)?.loaderData;
  const buckets = ld && typeof ld === 'object' ? Object.values(ld) : [decoded];
  for (const b of buckets) {
    const data = (b as any)?.serverResponse?.data ?? (b as any)?.data ?? b;
    if (data && typeof data === 'object' && (data.linear_conversation || data.mapping)) {
      return data;
    }
  }
  return null;
}

/** Reconstruct message order from a `mapping` graph (fallback when no linear_conversation). */
function orderedFromMapping(mapping: Record<string, any>): unknown[] {
  const nodes = Object.values(mapping);
  const root = nodes.find((n) => !n?.parent);
  if (!root) {
    return nodes
      .filter((n) => n?.message)
      .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
  }
  const ordered: unknown[] = [];
  let cur: any = root;
  const seen = new Set<string>();
  while (cur) {
    if (cur.message) ordered.push(cur);
    const childId: string | undefined = cur.children?.[0];
    if (!childId || seen.has(childId)) break;
    seen.add(childId);
    cur = mapping[childId];
  }
  return ordered;
}

function extractText(content: any): string {
  if (!content) return '';
  const parts = content.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

export interface ImportOptions {
  withResponses?: boolean;
  sessionId?: string;
}

export interface ImportResult {
  title: string;
  prompts: number;
  responses: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed conversation into the trail: user messages become `prompt`
 * events, assistant messages become `ai_output` (only with `withResponses`),
 * each tagged `tool: chatgpt`, stamped with the original time, and deduped by
 * the ChatGPT message id so re-importing the same link adds nothing.
 */
export async function importConversation(
  paths: ShowtailPaths,
  conversation: ParsedConversation,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const seen = importedSourceIds(paths);
  const result: ImportResult = {
    title: conversation.title,
    prompts: 0,
    responses: 0,
    skipped: 0,
  };

  for (const msg of conversation.messages) {
    const type =
      msg.role === 'user' ? 'prompt' : msg.role === 'assistant' ? 'ai_output' : null;
    if (type === null) continue;
    if (type === 'ai_output' && !options.withResponses) continue;

    const sourceId =
      msg.id || `chatgpt:${conversation.id}:${result.prompts + result.responses}`;
    if (seen.has(sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(sourceId);

    const timestamp = msg.createTime
      ? new Date(msg.createTime * 1000).toISOString()
      : undefined;

    await logEvent(paths, {
      type,
      text: msg.text,
      tool: 'chatgpt',
      timestamp,
      sourceId,
      sessionId: options.sessionId,
    });

    if (type === 'prompt') result.prompts += 1;
    else result.responses += 1;
    if (timestamp) {
      if (!result.first || timestamp < result.first) result.first = timestamp;
      if (!result.last || timestamp > result.last) result.last = timestamp;
    }
  }

  return result;
}
