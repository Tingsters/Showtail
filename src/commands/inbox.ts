/**
 * `showtail inbox` — the unplaced-session tray. Lists the sessions the ledger
 * captured but couldn't route to a project (a scratch IDE workspace, a global
 * tool running in HOME, a zero-edit planning session), plus any whose target
 * trail has since gone missing. On a terminal it doubles as a picker: choose
 * sessions and the repo to place them in, and it reattaches them. Without a TTY
 * (or with `--json`) it just reports, so scripts/agents can drive `reattach`.
 *
 * To relocate an ALREADY-placed session, see `showtail move` (lists every session).
 */
import { emitJson } from '../core/output.ts';
import { oneLine } from '../core/text.ts';
import { unplacedSessions, type LedgerSession } from '../core/ledger.ts';
import { reattachLedgerSession } from './reattach.ts';
import { ask, pickSessions, relativeTime, summarize } from './sessionPicker.ts';

type Unplaced = LedgerSession & { targetMissing?: boolean };

/** Print one session as the numbered block shown in the listing / picker. */
function printSession(session: Unplaced, ordinal: number): void {
  const { prompts, edits, firstPrompt } = summarize(session.id);
  const meta = [`${prompts} prompt(s)`, `${edits} edit(s)`];
  const flag = session.targetMissing ? '  [target missing]' : '';
  console.log(
    `  ${ordinal}. ${relativeTime(session.lastSeenAt)}    ${meta.join(', ')} · ${session.tool}${flag}`,
  );
  if (firstPrompt) console.log(`     first: ${oneLine(firstPrompt, 100)}`);
  if (session.cwd) console.log(`     cwd:   ${session.cwd}`);
  console.log(`     id: ${session.id}`);
  console.log('');
}

/** Machine-readable shape for `--json`. */
function toJson(session: Unplaced): Record<string, unknown> {
  const { prompts, edits, firstPrompt } = summarize(session.id);
  return {
    id: session.id,
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd ?? null,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    status: session.targetMissing ? 'target-missing' : 'inbox',
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

/** CLI entry point for `showtail inbox`. */
export async function runInbox(
  opts: { json?: boolean; cwd?: string } = {},
): Promise<void> {
  const sessions = unplacedSessions();

  if (opts.json) {
    emitJson({ sessions: sessions.map(toJson) });
    return;
  }

  if (sessions.length === 0) {
    console.log('Inbox empty — every captured session is placed in a project.');
    return;
  }

  console.log(`Unplaced sessions (${sessions.length}):`);
  console.log('');
  sessions.forEach((s, i) => printSession(s, i + 1));

  // Non-interactive: just report and show how to place one by id.
  if (!process.stdin.isTTY) {
    console.log('Place one with:  showtail reattach <session-id> --to <path>');
    return;
  }

  const chosen = await pickSessions(
    sessions,
    `Pick sessions to place [e.g. 1,3 or 'all', q to quit]:`,
  );
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }

  const toPath = await ask('Place into which project path?', opts.cwd ?? process.cwd());
  for (const session of chosen) {
    const { root, projected } = await reattachLedgerSession(session, toPath);
    console.log(`  ${session.id} → ${root} — ${projected} record(s) projected.`);
  }
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
