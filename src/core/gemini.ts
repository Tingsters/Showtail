import {
  parseTranscript as parseTranscriptShared,
  type ParsedConversation,
  type ParsedMessage,
  type TranscriptParseOptions,
  type TranscriptResult,
} from './importCommon.ts';

// The generic import machinery lives in importCommon.ts. Re-export the parts a
// caller of this module (and the tests) need, mirroring chatgpt.ts.
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

/** rpcid that loads a public shared conversation (Gemini's `boq-bard-web` app). */
const RPCID = 'ujx1Bf';
const BATCHEXECUTE_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

/**
 * Guidance shown whenever a link/saved page can't be read. Paste is the reliable
 * fallback, so any RPC/shape change degrades to it rather than failing hard.
 */
const FALLBACK_MSG =
  'Could not read the Gemini conversation automatically (the share format may have changed). ' +
  'Use --paste to paste the conversation, or --file a saved transcript.';

/**
 * Pull the canonical share id out of a `gemini.google.com/share/<id>` or
 * `g.co/gemini/share/<id>` URL (the path token is the id the RPC wants). Short
 * `share.gemini.google/<token>` links use a *different* token and must be
 * resolved via {@link resolveShortShareId} first — they return null here.
 */
export function shareIdFromUrl(url: string): string | null {
  const m = url.match(
    /^https:\/\/(?:gemini\.google\.com\/share|g\.co\/gemini\/share)\/([\w-]+)/i,
  );
  return m ? m[1]! : null;
}

/** A short share link (share.gemini.google/<token>) that 301s to the canonical URL. */
function isShortShareUrl(url: string): boolean {
  return /^https:\/\/share\.gemini\.google\/[\w-]+/i.test(url);
}

/**
 * Resolve a short `share.gemini.google/<token>` link to its canonical share id
 * by following the redirect (the token itself is not the id the RPC accepts).
 */
async function resolveShortShareId(url: string): Promise<string | null> {
  // Read the Location header without downloading the page when possible.
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA },
      redirect: 'manual',
    });
    const loc = res.headers.get('location');
    const id = loc ? shareIdFromUrl(loc) : null;
    if (id) return id;
  } catch {
    // Fall through to the follow-redirect path below.
  }
  const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA } });
  return shareIdFromUrl(res.url);
}

/**
 * Fetch a public Gemini conversation. Gemini's share *page* doesn't contain the
 * chat (the Angular app loads it client-side), so we replicate that load: a
 * `batchexecute` RPC keyed by the share id. It needs no auth — just a browser
 * UA. Returns the raw RPC response body for `parseShareHtml` to decode.
 */
export async function fetchSharedConversation(url: string): Promise<string> {
  let shareId = shareIdFromUrl(url);
  if (!shareId && isShortShareUrl(url)) {
    shareId = await resolveShortShareId(url);
  }
  if (!shareId) {
    throw new Error('Pass a Gemini share URL like https://gemini.google.com/share/<id>.');
  }
  const fReq = JSON.stringify([
    [[RPCID, JSON.stringify([null, shareId, [4]]), null, 'generic']],
  ]);
  const res = await fetch(`${BATCHEXECUTE_URL}?rpcids=${RPCID}&rt=c`, {
    method: 'POST',
    headers: {
      'user-agent': BROWSER_UA,
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: new URLSearchParams({ 'f.req': fReq }),
  });
  if (!res.ok) {
    throw new Error(
      `Could not fetch the share link (HTTP ${res.status}). Check the URL, or paste the ` +
        `conversation with --paste.`,
    );
  }
  return res.text();
}

/** Does this text look like a Gemini batchexecute response (vs HTML/transcript)? */
function looksLikeRpcBody(text: string): boolean {
  return /"wrb\.fr"/.test(text) || text.trimStart().startsWith(")]}'");
}

/**
 * Decode a Gemini `batchexecute` response into a conversation. The body is the
 * anti-XSSI prefix `)]}'` followed by length-prefixed JSON chunks; the chat is
 * the `["wrb.fr","ujx1Bf",<payloadString>,…]` entry. We pull the turns out of
 * the (positional, undocumented) payload defensively — anything unexpected
 * throws the paste-fallback so the CLI never crashes on a format change.
 *
 * Kept named `parseShareHtml` (mirroring chatgpt.ts) so callers and tests share
 * one decode entry point; given non-RPC input (e.g. a saved HTML page) it throws
 * the same paste guidance.
 */
export async function parseShareHtml(text: string): Promise<ParsedConversation> {
  if (!looksLikeRpcBody(text)) throw new Error(FALLBACK_MSG);

  let payload: unknown;
  try {
    const fr = findRpcEntry(text);
    if (!fr || fr[2] == null) throw new Error('no payload'); // invalid/expired share
    payload = JSON.parse(fr[2] as string);
  } catch {
    throw new Error(FALLBACK_MSG);
  }

  const conversation = conversationFromPayload(payload);
  if (!conversation || conversation.messages.length === 0) {
    throw new Error(FALLBACK_MSG);
  }
  return conversation;
}

/** Walk the balanced top-level `[...]` chunks and return the wrb.fr/ujx1Bf entry. */
function findRpcEntry(body: string): unknown[] | null {
  let p = body.indexOf('[');
  while (p >= 0 && p < body.length) {
    if (body[p] !== '[') {
      p++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = p; j < body.length; j++) {
      const c = body[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      const chunk = JSON.parse(body.slice(p, end));
      if (Array.isArray(chunk)) {
        for (const ent of chunk) {
          if (Array.isArray(ent) && ent[0] === 'wrb.fr' && ent[1] === RPCID) return ent;
        }
      }
    } catch {
      // Skip a chunk we can't parse rather than failing the whole decode.
    }
    p = end;
  }
  return null;
}

/** Safe positional access into the decoded payload. */
function at(node: unknown, path: number[]): unknown {
  return path.reduce<unknown>(
    (acc, key) => (acc == null ? acc : (acc as Record<number, unknown>)[key]),
    node,
  );
}

/**
 * The model name for the conversation, if the payload carries it. It sits in the
 * conversation-metadata list (`payload[0][2]`, alongside the title) as a triple
 * `[2, <responseId>, "<model>"]` — already a human-readable name (e.g. "3.5
 * Flash"). We scan for that shape rather than a fixed index, so a positional
 * shift doesn't silently drop it. Conversation-level (one model per share).
 */
function modelFromPayload(payload: unknown): string | undefined {
  const meta = at(payload, [0, 2]);
  if (!Array.isArray(meta)) return undefined;
  for (const el of meta) {
    if (
      Array.isArray(el) &&
      el.length === 3 &&
      el[0] === 2 &&
      typeof el[1] === 'string' &&
      typeof el[2] === 'string' &&
      el[2].trim()
    ) {
      return el[2].trim();
    }
  }
  return undefined;
}

/**
 * Pull the title and ordered turns out of the decoded payload. Each turn yields
 * a user prompt then the model's answer (interleaved order so the report pairs
 * them into one exchange). The response id `r_…` is unique per turn → the dedup
 * key; the assistant gets `<r_id>:r` so both survive idempotent re-import.
 */
function conversationFromPayload(payload: unknown): ParsedConversation | null {
  const turns = at(payload, [0, 1]);
  if (!Array.isArray(turns)) return null;

  const rawTitle = at(payload, [0, 2, 1]);
  const title =
    typeof rawTitle === 'string' && rawTitle.trim()
      ? rawTitle.trim()
      : 'Gemini conversation';
  const model = modelFromPayload(payload);

  const messages: ParsedMessage[] = [];
  for (const turn of turns) {
    const rid = at(turn, [0, 1]);
    const id = typeof rid === 'string' ? rid : '';
    const user = at(turn, [2, 0, 0]);
    const answer = at(turn, [3, 0, 0, 1, 0]);
    if (typeof user === 'string' && user.trim()) {
      messages.push({ id, role: 'user', text: user.trim() });
    }
    if (typeof answer === 'string' && answer.trim()) {
      messages.push({
        id: id ? `${id}:r` : '',
        role: 'assistant',
        text: answer.trim(),
        model,
      });
    }
  }
  return { title, messages };
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
