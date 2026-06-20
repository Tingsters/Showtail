import type { Session } from '../types.ts';
import { makeId } from './ids.ts';
import {
  readSessions,
  readState,
  writeSessions,
  writeState,
  type ShowtailPaths,
} from './storage.ts';

/** Build a new in-memory Session record (not yet persisted). */
export function makeSession(label?: string): Session {
  const id = makeId('ses');
  const session: Session = {
    id,
    startedAt: new Date().toISOString(),
    file: `sessions/${id}.jsonl`,
  };
  if (label) session.label = label;
  return session;
}

/**
 * Start and persist a new session, making it the current session that future
 * `log` events flow into. Returns the new session.
 */
export function startSession(paths: ShowtailPaths, label?: string): Session {
  const session = makeSession(label);
  const sessions = readSessions(paths);
  sessions.push(session);
  writeSessions(paths, sessions);
  writeState(paths, { currentSessionId: session.id });
  return session;
}

/** The currently active session, or null if none. */
export function currentSession(paths: ShowtailPaths): Session | null {
  const state = readState(paths);
  if (!state.currentSessionId) return null;
  const sessions = readSessions(paths);
  return sessions.find((s) => s.id === state.currentSessionId) ?? null;
}

/**
 * The Showtail session that mirrors a given Claude Code `session_id`, creating
 * it on first sight. This is the durable 1:1 binding that lets concurrent or
 * resumed Claude sessions each keep their own trail, instead of all sharing the
 * single global `currentSessionId`. Does **not** touch `currentSessionId` — the
 * caller decides whether this session also becomes the CLI's "current" one.
 */
export function sessionForClaudeId(
  paths: ShowtailPaths,
  claudeSessionId: string,
  opts: { tool?: Session['tool'] } = {},
): Session {
  const existing = readSessions(paths).find((s) => s.claudeSessionId === claudeSessionId);
  if (existing) return existing;

  const session = makeSession();
  session.claudeSessionId = claudeSessionId;
  if (opts.tool) session.tool = opts.tool;
  // Re-read immediately before writing to shrink the window in which a
  // concurrent session-start for a *different* id could clobber this push.
  const sessions = readSessions(paths);
  if (!sessions.some((s) => s.claudeSessionId === claudeSessionId)) {
    sessions.push(session);
    writeSessions(paths, sessions);
    return session;
  }
  // Lost the race: another writer created it. Use theirs.
  return sessions.find((s) => s.claudeSessionId === claudeSessionId) ?? session;
}
