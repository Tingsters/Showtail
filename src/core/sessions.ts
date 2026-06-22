import type { Session } from '../types.ts';
import { makeId } from './ids.ts';
import {
  readSessions,
  readState,
  updateState,
  writeSessions,
  type AuthorPaths,
} from './storage.ts';

/** Build a new in-memory Session record (not yet persisted). */
export function makeSession(label?: string): Session {
  const id = makeId('ses');
  const session: Session = {
    id,
    startedAt: new Date().toISOString(),
  };
  if (label) session.label = label;
  return session;
}

/**
 * Start and persist a new session for one author, making it the current session
 * that future `log` events flow into. Returns the new session.
 */
export function startSession(author: AuthorPaths, label?: string): Session {
  const session = makeSession(label);
  const sessions = readSessions(author);
  sessions.push(session);
  writeSessions(author, sessions);
  // Merge (don't clobber) so the active-author slug and per-Claude-session turns
  // survive starting a new session.
  updateState(author.shared, { currentSessionId: session.id });
  return session;
}

/** The currently active session for this author, or null if none. */
export function currentSession(author: AuthorPaths): Session | null {
  const state = readState(author.shared);
  if (!state.currentSessionId) return null;
  const sessions = readSessions(author);
  return sessions.find((s) => s.id === state.currentSessionId) ?? null;
}

/**
 * Mark one author's session closed, stamping `endedAt` at `at` (idempotent — a
 * session already closed keeps its original time). Clears the shared
 * current-session pointer only when it points at *this* session, so closing one
 * session never disturbs a different concurrent one.
 */
export function closeSession(author: AuthorPaths, sessionId: string, at: string): void {
  const sessions = readSessions(author);
  const session = sessions.find((s) => s.id === sessionId);
  if (session && !session.endedAt) {
    session.endedAt = at;
    writeSessions(author, sessions);
  }
  const state = readState(author.shared);
  if (state.currentSessionId === sessionId) {
    updateState(author.shared, { currentSessionId: null, currentPromptId: null });
  }
}

/**
 * The session that mirrors a given host-tool session id for this author,
 * creating it on first sight. Binds to the *open* session for the id: a session
 * closed by idle-timeout or SessionEnd is left in place, and the same tool
 * session continuing after that is a new task that gets a fresh session (events
 * stay continuous on the timeline either way). A still-open session is reused —
 * so resumes/compacts within a session keep one trail. Does **not** touch
 * `currentSessionId` — the caller decides whether this also becomes the CLI's
 * "current" session.
 */
export function sessionForNativeSession(
  author: AuthorPaths,
  nativeSessionId: string,
  opts: { tool?: Session['tool'] } = {},
): Session {
  const open = (s: Session) => s.nativeSessionId === nativeSessionId && !s.endedAt;
  const existing = readSessions(author).find(open);
  if (existing) return existing;

  const session = makeSession();
  session.nativeSessionId = nativeSessionId;
  if (opts.tool) session.tool = opts.tool;
  // Re-read immediately before writing to shrink the window in which a
  // concurrent session-start for a *different* id could clobber this push.
  const sessions = readSessions(author);
  if (!sessions.some(open)) {
    sessions.push(session);
    writeSessions(author, sessions);
    return session;
  }
  // Lost the race: another writer created it. Use theirs.
  return sessions.find(open) ?? session;
}
