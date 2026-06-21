import { requirePaths } from '../core/storage.ts';
import { activeAuthorPaths } from '../core/authors.ts';
import { currentSession } from '../core/sessions.ts';
import { readSessionEvents } from '../core/events.ts';
import { connectedToolsLines, toolStatuses } from '../core/tools.ts';
import { EVENT_TYPES } from '../types.ts';

export interface StatusOptions {
  /** Emit machine-readable JSON (consumed by the skill to decide manual capture). */
  json?: boolean;
  cwd?: string;
}

/**
 * Show the current session (event count + per-type breakdown) and which tool
 * integrations are connected. `--json` exposes `hooksActive` (Claude Code
 * auto-capture) for the skill to decide whether to capture prompts itself.
 */
export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const author = activeAuthorPaths(paths);
  const session = author ? currentSession(author) : null;
  const events = author && session ? readSessionEvents(author, session.id) : [];

  const counts: Partial<Record<string, number>> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const breakdown = EVENT_TYPES.filter((t) => counts[t]).map((t) => ({
    type: t,
    count: counts[t] as number,
  }));

  const tools = toolStatuses(options.cwd);
  const claudeHooks = tools.find((t) => t.tool === 'claude')?.hooksActive ?? false;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          session: session
            ? {
                id: session.id,
                label: session.label ?? null,
                startedAt: session.startedAt,
                events: events.length,
                byType: Object.fromEntries(breakdown.map((b) => [b.type, b.count])),
              }
            : null,
          hooksActive: claudeHooks,
          tools,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (session) {
    const label = session.label ? `  "${session.label}"` : '';
    console.log(`Session  ${session.id}${label}`);
    const when = new Date(session.startedAt).toLocaleString();
    console.log(`  started ${when} · ${events.length} event${plural(events.length)}`);
    if (breakdown.length > 0) {
      console.log('  ' + breakdown.map((b) => `${b.count} ${b.type}`).join(' · '));
    }
  } else {
    console.log('No open session. Run `showtail start` to begin one.');
  }

  console.log('');
  console.log('Connected tools');
  for (const line of connectedToolsLines(tools)) console.log(line);
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}
