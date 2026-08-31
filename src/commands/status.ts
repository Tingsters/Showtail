import { readConfig, requirePaths, trailIsNewerThanBinary } from '../core/storage.ts';
import { activeAuthorPaths, upgradeIdentityIfProvisional } from '../core/authors.ts';
import { autoInitEnabled, noteKnownProject } from '../core/globalConfig.ts';
import { currentSession } from '../core/sessions.ts';
import { readSessionEvents } from '../core/events.ts';
import { noteTrailAt, unplacedSessions } from '../core/ledger.ts';
import { connectedToolsLines, toolStatuses } from '../core/tools.ts';
import { emitJson } from '../core/output.ts';
import { pluralS } from '../core/text.ts';
import { EVENT_TYPES } from '../types.ts';

/** Count of globally-captured sessions awaiting placement (best-effort; never throws). */
function inboxCount(): number {
  try {
    return unplacedSessions().length;
  } catch {
    return 0;
  }
}

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
  noteKnownProject(paths.root, readConfig(paths).trailId);
  // If capture has been under a computer-derived placeholder, adopt a real identity that
  // has since appeared (cheap sources only — no gh network call — so `status --json` stays
  // fast for the skill). Best-effort, silent.
  await upgradeIdentityIfProvisional(paths, {
    cwd: options.cwd ?? process.cwd(),
    allowGh: false,
  });
  // If this trail has moved since it was last placed, repoint the ledger index now
  // rather than leaving every past session flagged target-missing until the student
  // happens to run an AI session here again.
  const relocated = noteTrailAt(paths.root);
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
  const inbox = inboxCount();
  const trailNewer = trailIsNewerThanBinary(paths);

  if (options.json) {
    const autoInit = autoInitEnabled();
    emitJson({
      initialized: true,
      trailNewer,
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
      autoInit,
      // Agents read `status --json` (see assets/**/*.showtail.md), so the move has
      // to be visible here too — not only in the human output.
      relocated: relocated?.moved
        ? {
            previousPath: relocated.previousPath ?? null,
            duplicated: relocated.duplicated,
          }
        : null,
      // Sessions captured globally (folderless/scratch tools) not yet placed in a project.
      inbox,
      nextAction: events.length > 0 ? 'report' : 'work',
      tools,
    });
    return;
  }

  if (trailNewer) {
    console.log(
      'Note: this trail was written by a newer Showtail — some sessions may not be ' +
        'visible. Upgrade Showtail to see everything.',
    );
    console.log('');
  }

  if (relocated?.moved) {
    if (relocated.duplicated) {
      console.log(
        'Warning: this trail also still exists at ' +
          `${relocated.previousPath} — it looks copied, not moved.`,
      );
      console.log(
        '  Two folders now share one trail id, so new work may be recorded against',
      );
      console.log('  the other copy. Delete the copy you are not using.');
    } else {
      console.log(`This project moved here from ${relocated.previousPath} — updated.`);
    }
    console.log('');
  }

  if (session) {
    const label = session.label ? `  "${session.label}"` : '';
    console.log(`Session  ${session.id}${label}`);
    const when = new Date(session.startedAt).toLocaleString();
    console.log(`  started ${when} · ${events.length} event${pluralS(events.length)}`);
    if (breakdown.length > 0) {
      console.log('  ' + breakdown.map((b) => `${b.count} ${b.type}`).join(' · '));
    }
  } else {
    console.log('No open session yet — just start working and one opens automatically.');
  }

  if (inbox > 0) {
    console.log('');
    console.log(
      `${inbox} session${pluralS(inbox)} captured but not yet placed in a project — run \`showtail inbox\`.`,
    );
  }

  console.log('');
  console.log('Connected tools');
  for (const line of connectedToolsLines(tools)) console.log(line);
}
