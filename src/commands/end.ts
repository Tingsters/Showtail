import {
  readSessions,
  readState,
  requirePaths,
  writeSessions,
  writeState,
} from '../core/storage.ts';

export interface EndOptions {
  cwd?: string;
}

/**
 * Close the current work session: stamp `endedAt` on it and clear the active
 * session so future `log` events start a fresh one. A no-op (friendly message)
 * when nothing is open.
 */
export async function runEnd(options: EndOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const state = readState(paths);

  if (!state.currentSessionId) {
    console.log('No open session to close. Run `showtail start` to begin one.');
    return;
  }

  const sessions = readSessions(paths);
  const session = sessions.find((s) => s.id === state.currentSessionId);
  if (session && !session.endedAt) {
    session.endedAt = new Date().toISOString();
    writeSessions(paths, sessions);
  }
  writeState(paths, { currentSessionId: null, currentPromptId: null });

  const label = session?.label ? ` "${session.label}"` : '';
  console.log(`Closed session ${state.currentSessionId}${label}.`);
  console.log('Start another anytime with `showtail start`.');
}
