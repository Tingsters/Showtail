import {
  parseTranscript as parseTranscriptShared,
  type ParsedConversation,
  type ParsedMessage,
  type TranscriptParseOptions,
  type TranscriptResult,
} from './importCommon.ts';

// The generic import machinery lives in importCommon.ts. Re-export the parts a
// caller of this module needs, mirroring chatgpt.ts.
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

/**
 * Guidance shown whenever the share page can't be parsed automatically. Gemini's
 * share format is undocumented and unstable, so paste is the reliable path.
 */
const FALLBACK_MSG =
  "Could not read the Gemini share page automatically (its format isn't stable). " +
  'Use --paste to paste the conversation, or --file a saved transcript.';

/** Fetch a public Gemini share page (a browser UA is required, as with ChatGPT). */
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
 * Parse a Gemini share page. Best-effort: Gemini is an Angular (`boq-bard-web`)
 * app that embeds the conversation in a large `window.WIZ_global_data` object as
 * a deeply/multiply-escaped, positionally-indexed blob — there is no stable
 * `author.role`/`linear_conversation` shape like ChatGPT's. We try the shapes we
 * recognize and, on anything unexpected, throw clear guidance to use --paste
 * rather than guessing (and never crash the CLI on a format change).
 */
export async function parseShareHtml(html: string): Promise<ParsedConversation> {
  let conversation: ParsedConversation | null = null;
  try {
    const data = extractWizGlobalData(html);
    conversation = data ? extractConversation(data) : null;
  } catch {
    // Any decode/shape error degrades to the paste fallback below.
    conversation = null;
  }
  if (!conversation || conversation.messages.length === 0) {
    throw new Error(FALLBACK_MSG);
  }
  return conversation;
}

/**
 * Pull and JSON-parse the `window.WIZ_global_data = {…};` object from the page.
 * Uses a balanced-brace scan because the object is large and contains nested
 * braces inside string values. Returns null if it isn't present.
 */
export function extractWizGlobalData(html: string): unknown | null {
  const marker = 'window.WIZ_global_data = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const objStart = html.indexOf('{', start);
  if (objStart === -1) return null;

  // Walk the object respecting string literals and escapes so braces inside
  // strings don't fool the brace counter.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objStart; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(html.slice(objStart, i + 1));
      }
    }
  }
  return null;
}

/**
 * Navigate a decoded Gemini payload to a conversation, if one is present in a
 * shape we recognize. Gemini's share blob does not currently expose a stable
 * role-tagged structure, so this is intentionally conservative: it returns null
 * (→ paste fallback) unless it finds an unambiguous user/model turn list. The
 * recognizer is isolated here so it's easy to extend when the format is known.
 */
export function extractConversation(decoded: unknown): ParsedConversation | null {
  const turns = findTurns(decoded);
  if (!turns || turns.length === 0) return null;
  const messages: ParsedMessage[] = [];
  for (const t of turns) {
    const text = t.text.trim();
    if (!text) continue;
    messages.push({ id: t.id ?? '', role: t.role, text });
  }
  return messages.length > 0 ? { title: 'Gemini conversation', messages } : null;
}

interface RawTurn {
  role: 'user' | 'assistant';
  text: string;
  id?: string;
}

/**
 * Look for an unambiguous list of conversation turns in the decoded payload.
 * Recognizes objects that carry an explicit role/author field alongside text.
 * Returns null when nothing matches — we do NOT guess roles from a positional
 * array, since that is the part of Gemini's format most likely to change.
 */
function findTurns(decoded: unknown): RawTurn[] | null {
  const out: RawTurn[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    const role = roleOf(obj);
    const text = textOf(obj);
    if (role && text) {
      out.push({ role, text, id: typeof obj.id === 'string' ? obj.id : undefined });
    }

    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };

  visit(decoded);
  return out.length > 0 ? out : null;
}

/** Map an explicit role/author field to our two roles, or null if absent/unknown. */
function roleOf(obj: Record<string, unknown>): 'user' | 'assistant' | null {
  const raw = obj.role ?? obj.author ?? obj.sender;
  if (typeof raw !== 'string') return null;
  const r = raw.toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'model' || r === 'assistant' || r === 'gemini' || r === 'bard') {
    return 'assistant';
  }
  return null;
}

/** Read the textual content of a turn-like object, if present. */
function textOf(obj: Record<string, unknown>): string | null {
  const t = obj.text ?? obj.content ?? obj.message;
  return typeof t === 'string' && t.trim() ? t : null;
}

// --- Manual paste / backup import -----------------------------------------

/** Role markers a Gemini page-copy includes (accessibility headings + labels). */
const GEMINI_ROLE_RE =
  /(You said:|Gemini said:|(?:^|\n)[ \t]*(?:You|User|Gemini|Bard|Assistant):)/gi;

/** Gemini-specific knobs for the shared transcript parser. */
export const GEMINI_TRANSCRIPT: TranscriptParseOptions = {
  roleRe: GEMINI_ROLE_RE,
  assistantTest: /gemini|bard|assistant/i,
  title: 'Gemini conversation (pasted)',
};

/** Parse a pasted Gemini transcript (thin wrapper over the shared parser). */
export function parseTranscript(input: string): TranscriptResult {
  return parseTranscriptShared(input, GEMINI_TRANSCRIPT);
}
