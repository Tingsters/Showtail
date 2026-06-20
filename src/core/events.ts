import type { Event, EventType, JournalEntry, Session, Tool } from '../types.ts';
import { maybeCurrentCommit } from './git.ts';
import { makeId } from './ids.ts';
import { readObject, writeObject } from './objects.ts';
import { redact } from './redact.ts';
import {
  JOURNAL_ENTRY_VERSION,
  appendJournal,
  readConfig,
  readJournal,
  readSessions,
  readState,
  rewriteJournal,
  updateState,
  writeSessions,
  type ShowtailPaths,
} from './storage.ts';
import { makeSession } from './sessions.ts';
import { validateEvent } from './schema.ts';
import { oneLine } from './text.ts';

/** Fields a caller provides when logging a new event. */
export interface NewEventInput {
  type: EventType;
  text: string;
  files?: string[];
  tags?: string[];
  /** Which tool the work flowed through. Defaults to "cli". */
  tool?: Tool;
  /** Override the timestamp (for imports of past activity). Defaults to now. */
  timestamp?: string;
  /** Stable external id for idempotent imports (e.g. a ChatGPT message id). */
  sourceId?: string;
  /** Groups events from one import run so the whole batch can be undone together. */
  batchId?: string;
  /** Links this event to the prompt that opened its turn. */
  turnId?: string;
  /** Force a specific session; otherwise the current/started session is used. */
  sessionId?: string;
}

/** A one-line preview kept in the journal so the content stays glanceable. */
function preview(text: string): string {
  return oneLine(text, 140);
}

/**
 * Append a new event and return both the event and the session it landed in. If
 * no session is active, one is started automatically so a student never loses a
 * log to a "no session" error.
 *
 * The event's text is scrubbed of secrets/PII, then stored in the content-
 * addressed object store; only metadata + the object reference go in the
 * append-only journal.
 */
export async function logEvent(
  paths: ShowtailPaths,
  input: NewEventInput,
): Promise<{ event: Event; session: Session }> {
  const session = resolveOrStartSession(paths, input.sessionId);

  const config = readConfig(paths);
  // Imported (back-dated) events don't get a git commit — a past message's
  // commit isn't meaningful; only live events capture the current commit.
  const gitCommit = input.timestamp
    ? undefined
    : await maybeCurrentCommit(paths.root, config.settings.git);

  // Scrub before anything touches disk, then hash the *redacted* text.
  const { text, hits } = redact(input.text, config.settings.redact);
  const ref = writeObject(paths, text);

  const timestamp = input.timestamp ?? new Date().toISOString();
  const id = makeId('evt');

  const entry: JournalEntry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'event',
    id,
    ts: timestamp,
    type: input.type,
    tool: input.tool ?? 'cli',
    conv: session.id,
    actor: 'student',
    refs: [ref],
    textPreview: preview(text),
    bytes: Buffer.byteLength(text),
  };
  if (hits > 0) entry.redacted = hits;
  if (input.files && input.files.length > 0) entry.files = input.files;
  if (input.tags && input.tags.length > 0) entry.tags = input.tags;
  if (input.sourceId) entry.sourceId = input.sourceId;
  if (input.batchId) entry.batch = input.batchId;
  if (input.turnId) entry.turn = input.turnId;
  if (gitCommit) entry.gitCommit = gitCommit;

  appendJournal(paths, entry);
  return { event: eventFromEntry(paths, entry), session };
}

/** Reconstruct an in-memory Event from a journal entry, resolving its content. */
export function eventFromEntry(paths: ShowtailPaths, entry: JournalEntry): Event {
  const text =
    (entry.refs && entry.refs.length > 0 ? readObject(paths, entry.refs[0]!) : null) ??
    entry.textPreview ??
    '';
  const event: Event = {
    id: entry.id,
    timestamp: entry.ts,
    type: entry.type as EventType,
    text,
    tool: entry.tool ?? 'cli',
    actor: entry.actor ?? 'student',
  };
  if (entry.files && entry.files.length > 0) event.files = entry.files;
  if (entry.tags && entry.tags.length > 0) event.tags = entry.tags;
  if (entry.gitCommit) event.gitCommit = entry.gitCommit;
  if (entry.sourceId) event.sourceId = entry.sourceId;
  if (entry.batch) event.batchId = entry.batch;
  if (entry.turn) event.turnId = entry.turn;
  return event;
}

/** Journal entries that represent logged events (not artifact file snapshots). */
function eventEntries(paths: ShowtailPaths): JournalEntry[] {
  return readJournal(paths).filter((e) => e.kind !== 'artifact');
}

/**
 * Find the session events should go to. Order of preference:
 *  1. An explicit `sessionId` (must exist).
 *  2. The current session recorded in state.
 *  3. A freshly auto-started session.
 */
export function resolveOrStartSession(
  paths: ShowtailPaths,
  explicitId?: string,
): Session {
  const sessions = readSessions(paths);

  if (explicitId) {
    const found = sessions.find((s) => s.id === explicitId);
    if (!found) {
      throw new Error(
        `Session "${explicitId}" was not found. Run \`showtail start\` or omit --session.`,
      );
    }
    return found;
  }

  const state = readState(paths);
  if (state.currentSessionId) {
    const current = sessions.find((s) => s.id === state.currentSessionId);
    if (current) return current;
  }

  // No usable current session: auto-start one.
  const session = makeSession();
  sessions.push(session);
  writeSessions(paths, sessions);
  updateState(paths, { currentSessionId: session.id, currentPromptId: null });
  return session;
}

/** Read all events for a single session. */
export function readSessionEvents(paths: ShowtailPaths, sessionId: string): Event[] {
  return eventEntries(paths)
    .filter((e) => e.conv === sessionId)
    .map((e) => eventFromEntry(paths, e));
}

/** The set of external source ids already imported (for idempotent imports). */
export function importedSourceIds(paths: ShowtailPaths): Set<string> {
  const ids = new Set<string>();
  for (const e of eventEntries(paths)) {
    if (e.sourceId) ids.add(e.sourceId);
  }
  return ids;
}

/**
 * The id of the most recent import batch, in write order (the last event that
 * carries a `batch`). This is "the import you just did", which is what
 * `showtail import undo` removes.
 */
export function latestBatchId(paths: ShowtailPaths): string | undefined {
  let latest: string | undefined;
  for (const e of readJournal(paths)) {
    if (e.batch) latest = e.batch;
  }
  return latest;
}

/**
 * Remove every journal entry tagged with `batchId` and return how many were
 * removed. Used to undo an import in one step. (Objects left for a future GC.)
 */
export function removeEventsByBatch(paths: ShowtailPaths, batchId: string): number {
  return rewriteJournal(paths, (e) => e.batch !== batchId);
}

/** Read every event across every session, in journal (write) order. */
export function readAllEvents(paths: ShowtailPaths): Event[] {
  return eventEntries(paths).map((e) => eventFromEntry(paths, e));
}

/**
 * Read every event together with the id of the session it belongs to.
 * Invalid reconstructions are skipped here; `verify` reports raw issues.
 */
export function readAllEventsWithSession(
  paths: ShowtailPaths,
): Array<{ event: Event; sessionId: string }> {
  const out: Array<{ event: Event; sessionId: string }> = [];
  for (const entry of eventEntries(paths)) {
    const event = eventFromEntry(paths, entry);
    if (validateEvent(event).length === 0) {
      out.push({ event, sessionId: entry.conv ?? '' });
    }
  }
  return out;
}
