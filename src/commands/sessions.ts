import { readSessions, readState, requirePaths } from '../core/storage.ts';
import { readSessionEvents } from '../core/events.ts';

export interface SessionsOptions {
  /** Emit machine-readable JSON. */
  json?: boolean;
  cwd?: string;
}

/** List every work session, marking the currently open one. */
export async function runSessions(options: SessionsOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const sessions = readSessions(paths);
  const currentId = readState(paths).currentSessionId;

  const rows = sessions.map((s) => ({
    id: s.id,
    label: s.label ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    events: readSessionEvents(paths, s.id).length,
    current: s.id === currentId,
  }));

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No sessions yet. Run `showtail start` to begin one.');
    return;
  }

  console.log(`${rows.length} session${rows.length === 1 ? '' : 's'}:`);
  console.log('');
  for (const r of rows) {
    const marker = r.current ? '*' : ' ';
    const label = r.label ? ` "${r.label}"` : '';
    const when = new Date(r.startedAt).toLocaleString();
    const ended = r.endedAt ? ' (ended)' : '';
    console.log(`${marker} ${r.id}${label}`);
    console.log(`    ${when} · ${r.events} event${r.events === 1 ? '' : 's'}${ended}`);
  }
  console.log('');
  console.log('* current session');
}
