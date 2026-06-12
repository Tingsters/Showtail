import type { Event, EventType, Session, Tool } from '../types.ts';
import { maybeCurrentCommit } from './git.ts';
import { makeId } from './ids.ts';
import {
  appendJsonl,
  readConfig,
  readJsonl,
  readSessions,
  readState,
  sessionFile,
  writeSessions,
  writeState,
  type ShowtailPaths,
} from './storage.ts';
import { makeSession } from './sessions.ts';
import { validateEvent } from './schema.ts';

/** Fields a caller provides when logging a new event. */
export interface NewEventInput {
  type: EventType;
  text: string;
  files?: string[];
  tags?: string[];
  /** Which tool the work flowed through. Defaults to "cli". */
  tool?: Tool;
  /** Force a specific session; otherwise the current/started session is used. */
  sessionId?: string;
}

/**
 * Append a new event to a session and return both the event and the session
 * it landed in. If no session is active, one is started automatically so a
 * student never loses a log to a "no session" error.
 */
export async function logEvent(
  paths: ShowtailPaths,
  input: NewEventInput,
): Promise<{ event: Event; session: Session }> {
  const session = resolveOrStartSession(paths, input.sessionId);

  const config = readConfig(paths);
  const gitCommit = await maybeCurrentCommit(paths.root, config.settings.git);

  const event: Event = {
    id: makeId('evt'),
    timestamp: new Date().toISOString(),
    type: input.type,
    text: input.text,
    tool: input.tool ?? 'cli',
    actor: 'student',
  };
  if (input.files && input.files.length > 0) event.files = input.files;
  if (input.tags && input.tags.length > 0) event.tags = input.tags;
  if (gitCommit) event.gitCommit = gitCommit;

  appendJsonl(sessionFile(paths, session.id), event);
  return { event, session };
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
  writeState(paths, { currentSessionId: session.id });
  return session;
}

/** Read all events for a single session. */
export function readSessionEvents(paths: ShowtailPaths, sessionId: string): Event[] {
  return readJsonl<Event>(sessionFile(paths, sessionId));
}

/** Read every event across every session, in session-index order. */
export function readAllEvents(paths: ShowtailPaths): Event[] {
  const sessions = readSessions(paths);
  const all: Event[] = [];
  for (const session of sessions) {
    all.push(...readSessionEvents(paths, session.id));
  }
  return all;
}

/**
 * Read every event together with the id of the session it belongs to.
 * Invalid lines are skipped here; `verify` is responsible for reporting them.
 */
export function readAllEventsWithSession(
  paths: ShowtailPaths,
): Array<{ event: Event; sessionId: string }> {
  const sessions = readSessions(paths);
  const out: Array<{ event: Event; sessionId: string }> = [];
  for (const session of sessions) {
    for (const event of readSessionEvents(paths, session.id)) {
      if (validateEvent(event).length === 0) {
        out.push({ event, sessionId: session.id });
      }
    }
  }
  return out;
}
