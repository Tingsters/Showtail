/**
 * Shared machinery for importing AI conversations into the trail.
 *
 * This is provider-agnostic: it owns the normalized conversation shape, the
 * pasted-transcript parser, and the import that turns a conversation into
 * `prompt`/`ai_output` events. Provider modules (chatgpt.ts, gemini.ts) supply
 * the share-page parsing and a small set of provider-specific transcript
 * options (role markers, title), then reuse everything here so the trail
 * invariants — dedup, timestamps, batch undo, tool tagging — live in one place.
 */
import { logEvent, importedSourceIds } from './events.ts';
import { sha256OfString } from './hash.ts';
import type { AuthorPaths } from './storage.ts';
import type { Tool } from '../types.ts';

export interface ParsedMessage {
  id: string;
  role: string; // user | assistant | system | tool
  text: string;
  /** Epoch seconds, when present. */
  createTime?: number;
  /** The AI model that produced this message (raw id), when the source exposes one. */
  model?: string;
}

export interface ParsedConversation {
  id?: string;
  title: string;
  messages: ParsedMessage[];
}

// --- Manual paste / backup import -----------------------------------------
//
// When a share link won't work, a student can paste the conversation text.
// We can't tell user vs. assistant prose apart by writing style (that would be
// AI-detection, which Showtail is not), so we key off *structural* markers:
// strip the UI chrome, normalize attachment chips, split on the provider's
// "You said:"/"<Assistant> said:" headings when present, and otherwise record
// what remains as the student's prompts. The student then skims and can undo.

/** Marks a turn boundary we discovered while stripping chrome (an invisible sentinel). */
const BOUNDARY = '';

/** Per-provider knobs for parsing a pasted transcript. */
export interface TranscriptParseOptions {
  /** Matches the role headings a page-copy includes (global, case-insensitive). */
  roleRe: RegExp;
  /** Tests a matched marker to decide if it's the assistant's turn. */
  assistantTest: RegExp;
  /** Title for the resulting conversation. */
  title: string;
}

export interface TranscriptResult {
  conversation: ParsedConversation;
  /** True if explicit role markers were found (so responses can be captured too). */
  markersFound: boolean;
}

/**
 * Parse a pasted transcript into a conversation. If role markers are present,
 * both prompts and responses are recovered; otherwise every cleaned block is
 * treated as a student prompt and `markersFound` is false.
 */
export function parseTranscript(
  input: string,
  options: TranscriptParseOptions,
): TranscriptResult {
  const text = input.replace(/\r\n?/g, '\n');
  const markers = [...text.matchAll(options.roleRe)];
  if (markers.length > 0) {
    return { conversation: fromMarkers(text, markers, options), markersFound: true };
  }
  return { conversation: fromPromptsOnly(text, options), markersFound: false };
}

/**
 * Strip page-copy chrome and normalize attachment chips, inserting a BOUNDARY
 * where a turn clearly ends (after an attachment, or at a reasoning /
 * action-button artifact).
 */
function cleanChrome(text: string): string {
  return (
    text
      // "Pasted text(9).txtDocument" -> "[attachment: Pasted text(9).txt]" + boundary.
      // The chip is glued to the next prompt (no space after "Document"), so no trailing \b.
      .replace(/([\w ()\-]+?\.[A-Za-z0-9]{1,6})Document/g, `[attachment: $1]${BOUNDARY}`)
      // reasoning chrome, often with the trailing "Edit" button glued on: a boundary
      .replace(/Thought for \d+\s*s(?:\s*Edit)?/g, BOUNDARY)
      // standalone action buttons on their own line
      .replace(/^[ \t]*(?:Edit|Copy|Regenerate|Read aloud|Share)[ \t]*$/gim, BOUNDARY)
  );
}

/** Build a message with a content-hash id so re-pasting the same text dedupes. */
function pasteMessage(role: string, text: string): ParsedMessage {
  return { id: 'paste:' + sha256OfString(role + '\n' + text).slice(0, 16), role, text };
}

/** Split a marked-up transcript into user/assistant turns at the role markers. */
function fromMarkers(
  text: string,
  markers: RegExpMatchArray[],
  options: TranscriptParseOptions,
): ParsedConversation {
  const messages: ParsedMessage[] = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const marker = m[0];
    const start = (m.index ?? 0) + marker.length;
    const end =
      i + 1 < markers.length ? (markers[i + 1]!.index ?? text.length) : text.length;
    const role = options.assistantTest.test(marker) ? 'assistant' : 'user';
    const body = cleanChrome(text.slice(start, end)).split(BOUNDARY).join('\n').trim();
    if (body) messages.push(pasteMessage(role, body));
  }
  return { title: options.title, messages };
}

/** No role markers: record each cleaned block as one of the student's prompts. */
function fromPromptsOnly(
  text: string,
  options: TranscriptParseOptions,
): ParsedConversation {
  const blocks = cleanChrome(text)
    .split(new RegExp(`${BOUNDARY}|\\n{2,}`))
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return {
    title: options.title,
    messages: blocks.map((b) => pasteMessage('user', b)),
  };
}

export interface ImportOptions {
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
  /** Fallback model id for imported `ai_output`s when the source has none (e.g. paste). */
  model?: string;
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
 * each tagged with `tool`, stamped with the original time, and deduped by the
 * source message id so re-importing the same conversation adds nothing.
 */
export async function importConversation(
  author: AuthorPaths,
  conversation: ParsedConversation,
  tool: Tool,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const seen = importedSourceIds(author);
  const result: ImportResult = {
    title: conversation.title,
    prompts: 0,
    responses: 0,
    skipped: 0,
  };

  // A user prompt opens a turn; the assistant reply links back via this id.
  let currentTurnId: string | undefined;

  for (const msg of conversation.messages) {
    const type =
      msg.role === 'user' ? 'prompt' : msg.role === 'assistant' ? 'ai_output' : null;
    if (type === null) continue;
    if (type === 'ai_output' && !options.withResponses) continue;

    const sourceId =
      msg.id || `${tool}:${conversation.id}:${result.prompts + result.responses}`;
    if (seen.has(sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(sourceId);

    const timestamp = msg.createTime
      ? new Date(msg.createTime * 1000).toISOString()
      : undefined;

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool,
      // The source's per-message model, falling back to an `--model` override for replies.
      model: type === 'ai_output' ? (msg.model ?? options.model) : msg.model,
      timestamp,
      sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      turnId: type === 'prompt' ? undefined : currentTurnId,
    });
    if (type === 'prompt') currentTurnId = event.id;

    if (type === 'prompt') result.prompts += 1;
    else result.responses += 1;
    if (timestamp) {
      if (!result.first || timestamp < result.first) result.first = timestamp;
      if (!result.last || timestamp > result.last) result.last = timestamp;
    }
  }

  return result;
}
