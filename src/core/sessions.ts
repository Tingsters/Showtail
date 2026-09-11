import type { Session } from '../types.ts';
import { CaptureInterruptedError, requireCaptureContinuation } from './captureGuard.ts';
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

/** Remove only the session this interrupted helper just created. */
function rollbackNewSession(author: AuthorPaths, sessionId: string): void {
  const sessions = readSessions(author);
  const withoutNew = sessions.filter((session) => session.id !== sessionId);
  if (withoutNew.length !== sessions.length) writeSessions(author, withoutNew);
}

/**
 * Start and persist a new session for one author, making it the current session
 * that future `log` events flow into. Returns the new session.
 */
export function startSession(
  author: AuthorPaths,
  label?: string,
  opts: { continueCapture?: () => boolean } = {},
): Session {
  requireCaptureContinuation(opts.continueCapture);
  const session = makeSession(label);
  session.machineId = author.machineId;
  const sessions = readSessions(author);
  sessions.push(session);
  requireCaptureContinuation(opts.continueCapture);
  writeSessions(author, sessions);
  // Merge (don't clobber) so the active-author slug and per-Claude-session turns
  // survive starting a new session.
  try {
    requireCaptureContinuation(opts.continueCapture);
    updateState(author.shared, { currentSessionId: session.id });
  } catch (error) {
    if (error instanceof CaptureInterruptedError) rollbackNewSession(author, session.id);
    throw error;
  }
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
export function closeSession(
  author: AuthorPaths,
  sessionId: string,
  at: string,
  opts: { continueCapture?: () => boolean } = {},
): void {
  requireCaptureContinuation(opts.continueCapture);
  const sessions = readSessions(author);
  const session = sessions.find((s) => s.id === sessionId);
  let closedNow = false;
  if (session && !session.endedAt) {
    session.endedAt = at;
    requireCaptureContinuation(opts.continueCapture);
    writeSessions(author, sessions);
    closedNow = true;
  }
  const state = readState(author.shared);
  if (state.currentSessionId === sessionId) {
    try {
      requireCaptureContinuation(opts.continueCapture);
      updateState(author.shared, { currentSessionId: null, currentPromptId: null });
    } catch (error) {
      if (error instanceof CaptureInterruptedError && closedNow) {
        const latest = readSessions(author);
        const written = latest.find((candidate) => candidate.id === sessionId);
        if (written?.endedAt === at) {
          delete written.endedAt;
          writeSessions(author, latest);
        }
      }
      throw error;
    }
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
  opts: { tool?: Session['tool']; continueCapture?: () => boolean } = {},
): Session {
  requireCaptureContinuation(opts.continueCapture);
  const open = (s: Session) => s.nativeSessionId === nativeSessionId && !s.endedAt;
  const existing = readSessions(author).find(open);
  if (existing) return existing;

  const session = makeSession();
  session.nativeSessionId = nativeSessionId;
  session.machineId = author.machineId;
  if (opts.tool) session.tool = opts.tool;
  // Re-read immediately before writing to shrink the window in which a
  // concurrent session-start for a *different* id could clobber this push.
  const sessions = readSessions(author);
  if (!sessions.some(open)) {
    sessions.push(session);
    requireCaptureContinuation(opts.continueCapture);
    writeSessions(author, sessions);
    return session;
  }
  // Lost the race: another writer created it. Use theirs.
  return sessions.find(open) ?? session;
}
