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
 * The session that mirrors a given Claude Code `session_id` for this author,
 * creating it on first sight. This is the durable 1:1 binding that lets
 * concurrent or resumed Claude sessions each keep their own trail. Because the
 * sessions file is now per-author (one writer per machine), the concurrency
 * window that the re-read below guards is far smaller than before. Does **not**
 * touch `currentSessionId` — the caller decides whether this also becomes the
 * CLI's "current" session.
 */
export function sessionForClaudeId(
  author: AuthorPaths,
  claudeSessionId: string,
  opts: { tool?: Session['tool'] } = {},
): Session {
  const existing = readSessions(author).find(
    (s) => s.claudeSessionId === claudeSessionId,
  );
  if (existing) return existing;

  const session = makeSession();
  session.claudeSessionId = claudeSessionId;
  if (opts.tool) session.tool = opts.tool;
  // Re-read immediately before writing to shrink the window in which a
  // concurrent session-start for a *different* id could clobber this push.
  const sessions = readSessions(author);
  if (!sessions.some((s) => s.claudeSessionId === claudeSessionId)) {
    sessions.push(session);
    writeSessions(author, sessions);
    return session;
  }
  // Lost the race: another writer created it. Use theirs.
  return sessions.find((s) => s.claudeSessionId === claudeSessionId) ?? session;
}
