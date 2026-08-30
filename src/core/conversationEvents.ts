/** Durable storage for the provider-neutral structured conversation stream. */
import type { Config, ConversationEvent, JsonValue, Tool } from '../types.ts';
import { authorSlugs } from './authors.ts';
import { resolveOrStartSession } from './events.ts';
import { makeId } from './ids.ts';
import { appendJournal, JOURNAL_ENTRY_VERSION, readJournal } from './journal.ts';
import { readObject, writeObject } from './objects.ts';
import { redact } from './redact.ts';
import {
  authorPaths,
  readConfig,
  type AuthorPaths,
  type ShowtailPaths,
} from './storage.ts';

export interface NewConversationEventInput {
  event: ConversationEvent & { sourceId: string };
  tool: Tool;
  turnId?: string;
  sessionId?: string;
  batchId?: string;
}

export interface ConversationEventWithSession {
  event: ConversationEvent;
  sessionId: string;
  actorSlug: string;
  turnId?: string;
  tool: Tool;
}

const MUTATION_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'write_to_file',
  'replace_file_content',
]);
const ALWAYS_CAPTURE_TOOLS = new Set([
  'askuserquestion',
  'request_user_input',
  'vscode_askquestions',
  'enterplanmode',
  'exitplanmode',
  'update_plan',
]);
const CONVERSATION_EVENT_TYPES = new Set([
  'assistant_text',
  'user_text',
  'tool_use',
  'tool_result',
  'plan_snapshot',
  'plan_approved',
]);

/** Apply the existing privacy/capture switches to one structured event. */
export function conversationEventEnabled(
  event: ConversationEvent,
  toolNames: Map<string, string>,
  settings: Config['settings'],
  options: { includeResponses?: boolean } = {},
): boolean {
  if (event.type === 'assistant_text') {
    return options.includeResponses !== false && settings.captureAiOutput !== false;
  }
  if (event.type === 'user_text' || event.type.startsWith('plan_')) return true;
  const name = (
    event.toolName ?? (event.toolUseId ? toolNames.get(event.toolUseId) : undefined)
  )?.toLowerCase();
  if (name && ALWAYS_CAPTURE_TOOLS.has(name)) return true;
  if (name && MUTATION_TOOLS.has(name)) return settings.captureCode !== false;
  return options.includeResponses !== false && settings.captureToolCalls !== false;
}

function sanitizeJson(
  value: unknown,
  cfg: Parameters<typeof redact>[1],
): { value?: JsonValue; hits: number } {
  if (value === null) return { value: null, hits: 0 };
  if (typeof value === 'string') {
    const result = redact(value, cfg);
    return { value: result.text, hits: result.hits };
  }
  if (typeof value === 'boolean') return { value, hits: 0 };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value, hits: 0 } : { hits: 0 };
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    let hits = 0;
    for (const item of value) {
      const sanitized = sanitizeJson(item, cfg);
      hits += sanitized.hits;
      if (sanitized.value !== undefined) out.push(sanitized.value);
    }
    return { value: out, hits };
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    let hits = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeJson(item, cfg);
      hits += sanitized.hits;
      if (sanitized.value !== undefined) out[key] = sanitized.value;
    }
    return { value: out, hits };
  }
  return { hits: 0 };
}

function sanitizeEvent(
  paths: ShowtailPaths,
  event: ConversationEvent & { sourceId: string },
): { event: ConversationEvent; hits: number } {
  const cfg = readConfig(paths).settings.redact;
  const payload = sanitizeJson(event, cfg);
  if (
    !payload.value ||
    Array.isArray(payload.value) ||
    typeof payload.value !== 'object'
  ) {
    throw new Error('Conversation event is not JSON-compatible.');
  }
  return { event: payload.value as unknown as ConversationEvent, hits: payload.hits };
}

/** Append one redacted structured conversation event to the normal hash-chained journal. */
export function logConversationEvent(
  author: AuthorPaths,
  input: NewConversationEventInput,
): ConversationEvent {
  const session = resolveOrStartSession(author, input.sessionId);
  const sanitized = sanitizeEvent(author.shared, input.event);
  const serialized = JSON.stringify(sanitized.event);
  const ref = writeObject(author.shared, serialized);
  const entry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'conversation' as const,
    id: makeId('raw'),
    ts: sanitized.event.timestamp ?? new Date().toISOString(),
    type: 'conversation' as const,
    tool: input.tool,
    conv: session.id,
    actorSlug: author.slug,
    refs: [ref],
    textPreview: `${sanitized.event.type} #${sanitized.event.sequence}`,
    bytes: Buffer.byteLength(serialized),
    sourceId: input.event.sourceId,
    sequence: sanitized.event.sequence,
    ...(input.turnId ? { turn: input.turnId } : {}),
    ...(input.batchId ? { batch: input.batchId } : {}),
    ...(sanitized.hits > 0 ? { redacted: sanitized.hits } : {}),
  };
  appendJournal(author, entry);
  return sanitized.event;
}

function eventFromEntry(
  paths: ShowtailPaths,
  entry: ReturnType<typeof readJournal>[number],
): ConversationEvent | null {
  const ref = entry.refs?.[0];
  if (!ref) return null;
  const raw = readObject(paths, ref);
  if (!raw) return null;
  try {
    const event = JSON.parse(raw) as ConversationEvent;
    if (
      !Number.isInteger(event.sequence) ||
      event.sequence < 0 ||
      typeof event.type !== 'string' ||
      !CONVERSATION_EVENT_TYPES.has(event.type)
    ) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

/** Structured source ids already stored for one author, used for idempotent reconcile/import. */
export function importedConversationSourceIds(author: AuthorPaths): Set<string> {
  return new Set(
    readJournal(author)
      .filter((entry) => entry.kind === 'conversation' && entry.sourceId)
      .map((entry) => entry.sourceId!),
  );
}

/** Read every structured conversation event across the report's authors. */
export function readAllConversationEventsWithSession(
  paths: ShowtailPaths,
): ConversationEventWithSession[] {
  const out: ConversationEventWithSession[] = [];
  for (const slug of authorSlugs(paths)) {
    const author = authorPaths(paths, slug);
    for (const entry of readJournal(author)) {
      if (entry.kind !== 'conversation') continue;
      const event = eventFromEntry(paths, entry);
      if (!event) continue;
      out.push({
        event,
        sessionId: entry.conv ?? '',
        actorSlug: slug,
        turnId: entry.turn,
        tool: entry.tool ?? 'cli',
      });
    }
  }
  return out;
}
