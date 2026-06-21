import { emitJson } from '../core/output.ts';
import { activeAuthorPaths } from '../core/authors.ts';
import { closeSession } from '../core/sessions.ts';
import { readSessions, readState, requirePaths } from '../core/storage.ts';

export interface EndOptions {
  cwd?: string;
  /** Emit machine-readable JSON instead of prose. */
  json?: boolean;
}

/**
 * Close the current work session: stamp `endedAt` on it and clear the active
 * session so future `log` events start a fresh one. A no-op (friendly message)
 * when nothing is open.
 */
export async function runEnd(options: EndOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const state = readState(paths);
  const author = activeAuthorPaths(paths);

  if (!state.currentSessionId || !author) {
    if (options.json) {
      emitJson({ closed: false, sessionId: null, endedAt: null });
      return;
    }
    console.log('No open session to close. Run `showtail start` to begin one.');
    return;
  }

  const sessionId = state.currentSessionId;
  closeSession(author, sessionId, new Date().toISOString());
  const session = readSessions(author).find((s) => s.id === sessionId);

  if (options.json) {
    emitJson({ closed: true, sessionId, endedAt: session?.endedAt ?? null });
    return;
  }

  const label = session?.label ? ` "${session.label}"` : '';
  console.log(`Closed session ${sessionId}${label}.`);
  console.log('Start another anytime with `showtail start`.');
}
