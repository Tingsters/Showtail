import { authorPaths, readSessions, readState, requirePaths } from '../core/storage.ts';
import { activeAuthorPaths, authorSlugs } from '../core/authors.ts';
import { readSessionEvents } from '../core/events.ts';
import { emitJson } from '../core/output.ts';
import { pluralS } from '../core/text.ts';

export interface SessionsOptions {
  /** Emit machine-readable JSON. */
  json?: boolean;
  /** List sessions for every author in the project (not just the active one). */
  all?: boolean;
  cwd?: string;
}

/** List work sessions, marking the currently open one. */
export async function runSessions(options: SessionsOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const currentId = readState(paths).currentSessionId;

  // Default to the active author's sessions; `--all` aggregates everyone's.
  const authors = options.all
    ? authorSlugs(paths).map((slug) => authorPaths(paths, slug))
    : (() => {
        const a = activeAuthorPaths(paths);
        return a ? [a] : [];
      })();

  const rows = authors.flatMap((author) =>
    readSessions(author).map((s) => ({
      id: s.id,
      author: author.slug,
      label: s.label ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      events: readSessionEvents(author, s.id).length,
      current: s.id === currentId,
    })),
  );
  rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (options.json) {
    emitJson(rows);
    return;
  }

  if (rows.length === 0) {
    console.log('No sessions yet. Run `showtail start` to begin one.');
    return;
  }

  console.log(`${rows.length} session${pluralS(rows.length)}:`);
  console.log('');
  for (const r of rows) {
    const marker = r.current ? '*' : ' ';
    const label = r.label ? ` "${r.label}"` : '';
    const who = options.all ? ` · ${r.author}` : '';
    const when = new Date(r.startedAt).toLocaleString();
    const ended = r.endedAt ? ' (ended)' : '';
    console.log(`${marker} ${r.id}${label}${who}`);
    console.log(`    ${when} · ${r.events} event${pluralS(r.events)}${ended}`);
  }
  console.log('');
  console.log('* current session');
}
