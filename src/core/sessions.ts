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
