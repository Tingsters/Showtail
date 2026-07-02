/**
 * `showtail move` — relocate a captured session from one project folder to another.
 *
 * With no id it lists EVERY ledger session (placed, inbox, or target-missing) with
 * its `led_…` id and current folder, then interactively moves the chosen one(s).
 * `move <id> --to <path>` is the scriptable form. The move lifts the session off its
 * old trail and re-projects it into the new one (via {@link reattachLedgerSession}).
 *
 * Only sessions the ledger knows about (captured on 0.11+) can be moved; pre-upgrade
 * sessions live only in their repo trail and aren't listed here.
 */
import { emitJson } from '../core/output.ts';
import { oneLine } from '../core/text.ts';
import {
  allLedgerSessionViews,
  resolveLedgerSessionId,
  type LedgerSession,
  type LedgerSessionView,
} from '../core/ledger.ts';
import { reattachLedgerSession } from './reattach.ts';
import { ask, pickSessions, relativeTime, summarize } from './sessionPicker.ts';

/** A one-line status/location label for a session. */
function location(s: LedgerSessionView): string {
  if (s.status === 'inbox') return '[inbox]';
  if (s.targetMissing) {
    return `[target missing]${s.targetPaths[0] ? ` (was ${s.targetPaths[0]})` : ''}`;
  }
  return s.targetPaths.length > 0 ? `→ ${s.targetPaths.join(', ')}` : '[placed]';
}

/** Print one session as the numbered block shown in the listing / picker. */
function printSession(s: LedgerSessionView, ordinal: number): void {
  const { prompts, edits, firstPrompt } = summarize(s.id);
  console.log(
    `  ${ordinal}. ${relativeTime(s.lastSeenAt)}    ${prompts} prompt(s), ${edits} edit(s) · ${s.tool}   ${location(s)}`,
  );
  if (firstPrompt) console.log(`     first: ${oneLine(firstPrompt, 100)}`);
  console.log(`     id: ${s.id}`);
  console.log('');
}

/** Machine-readable shape for `--json`. */
function toJson(s: LedgerSessionView): Record<string, unknown> {
  const { prompts, edits, firstPrompt } = summarize(s.id);
  return {
    id: s.id,
    tool: s.tool,
    nativeSessionId: s.nativeSessionId,
    status: s.targetMissing ? 'target-missing' : s.status,
    paths: s.targetPaths,
    cwd: s.cwd ?? null,
    startedAt: s.startedAt,
    lastSeenAt: s.lastSeenAt,
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

/** Move one session to `toPath`, printing the outcome. */
async function moveOne(session: LedgerSession, toPath: string): Promise<void> {
  const { root, projected, movedFrom } = await reattachLedgerSession(session, toPath);
  if (movedFrom.length > 0) {
    console.log(`Moved ${session.id} off ${movedFrom.join(', ')}.`);
  }
  console.log(`Placed ${session.id} into ${root} — ${projected} record(s) projected.`);
}

/** CLI entry point for `showtail move`. */
export async function runMove(
  sessionId: string | undefined,
  opts: { to?: string; json?: boolean; cwd?: string } = {},
): Promise<void> {
  // Scriptable form: a specific session id.
  if (sessionId) {
    const session = resolveLedgerSessionId(sessionId);
    if (!session) {
      throw new Error(
        `No ledger session matching "${sessionId}". Run \`showtail move\` to list sessions.`,
      );
    }
    await moveOne(session, opts.to ?? opts.cwd ?? process.cwd());
    console.log('Run `showtail report` there to see it alongside your other work.');
    return;
  }

  const sessions = allLedgerSessionViews();

  if (opts.json) {
    emitJson({ sessions: sessions.map(toJson) });
    return;
  }

  if (sessions.length === 0) {
    console.log('No captured sessions yet.');
    return;
  }

  console.log(`Sessions (${sessions.length}):`);
  console.log('');
  sessions.forEach((s, i) => printSession(s, i + 1));

  // Non-interactive: list and show how to move by id.
  if (!process.stdin.isTTY) {
    console.log('Move one with:  showtail move <session-id> --to <path>');
    return;
  }

  const chosen = await pickSessions(
    sessions,
    `Move which session(s)? [e.g. 2, q to quit]:`,
  );
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }
  const toPath = await ask('Move into which project path?', opts.cwd ?? process.cwd());
  for (const s of chosen) await moveOne(s, toPath);
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
