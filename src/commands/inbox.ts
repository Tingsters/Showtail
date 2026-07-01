/**
 * `showtail inbox` — the unplaced-session tray. By default it lists only sessions
 * worth placing: real-project, signal-bearing work the ledger captured but couldn't
 * route (plus any whose target trail has gone missing). Scratch — folderless / home /
 * temp / trivial / ignored / dismissed work — stays in the ledger but is hidden here;
 * `showtail inbox --all` reveals it, tagged with why.
 *
 * On a terminal it doubles as a picker: choose sessions and the repo to place them in
 * (reattach), or dismiss them from the default view (`d1,3` / `dismiss all`). Without a
 * TTY (or with `--json`) it just reports, so scripts/agents can drive `reattach`/`move`.
 */
import { emitJson } from '../core/output.ts';
import { oneLine } from '../core/text.ts';
import {
  dismissLedgerSession,
  hiddenReason,
  sessionWorkRoots,
  unplacedSessions,
  type HiddenReason,
  type LedgerSession,
} from '../core/ledger.ts';
import { reattachLedgerSession } from './reattach.ts';
import { ask, pickSessionsWithAction, relativeTime, summarize } from './sessionPicker.ts';

type Unplaced = LedgerSession & { targetMissing?: boolean };

/** Calm pointers (number-free). ALL_HINT shows when scratch is kept aside; HELP_HINT always. */
const ALL_HINT =
  "'showtail inbox --all' shows scratch kept aside (all local; you can delete it).";
const HELP_HINT = "'showtail inbox --help' lists all inbox commands.";

/** Print the calm pointer line(s): the `--all` recovery hint (only if scratch exists) + `--help`. */
function printHints(hiddenExist: boolean): void {
  if (hiddenExist) console.log(ALL_HINT);
  console.log(HELP_HINT);
}

/** Human tag for why a session is hidden (only shown in the `--all` view). */
const REASON_TAG: Record<HiddenReason, string> = {
  dismissed: '[dismissed]',
  'not-in-project': '[scratch: not in a project]',
  'low-signal': '[scratch: low-signal]',
  'ignored-path': '[scratch: ignored path]',
};

/** The group a session is listed under: its resolved project root, else its cwd. */
function groupKey(session: Unplaced): string {
  const roots = sessionWorkRoots(session);
  return roots[0] ?? session.cwd ?? '(no files)';
}

/** The trailing tag for a session in the `--all` listing (missing target, or hide reason). */
function tagFor(session: Unplaced, showHidden: boolean): string {
  if (session.targetMissing) return '  [target missing]';
  if (!showHidden) return '';
  const reason = hiddenReason(session);
  return reason ? `  ${REASON_TAG[reason]}` : '';
}

/** Print one session as the numbered block shown in the listing / picker. */
function printSession(session: Unplaced, ordinal: number, showHidden: boolean): void {
  const { prompts, edits, firstPrompt } = summarize(session.id);
  console.log(
    `  ${ordinal}. ${relativeTime(session.lastSeenAt)}    ${prompts} prompt(s), ${edits} edit(s) · ${session.tool}${tagFor(session, showHidden)}`,
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
    hiddenReason: session.targetMissing ? null : hiddenReason(session),
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

/**
 * Print the sessions grouped by resolved work root and return them flattened in the
 * printed order, so the picker's ordinals line up with what the student sees.
 */
function printGrouped(sessions: Unplaced[], showHidden: boolean): Unplaced[] {
  const groups = new Map<string, Unplaced[]>();
  for (const s of sessions) {
    const key = groupKey(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const ordered: Unplaced[] = [];
  let n = 0;
  for (const [root, items] of groups) {
    console.log(`  ${root}`);
    for (const s of items) {
      n += 1;
      printSession(s, n, showHidden);
      ordered.push(s);
    }
  }
  return ordered;
}

/** CLI entry point for `showtail inbox`. */
export async function runInbox(
  opts: { json?: boolean; all?: boolean; cwd?: string } = {},
): Promise<void> {
  const showHidden = opts.all === true;
  const sessions = unplacedSessions({ includeHidden: showHidden });

  if (opts.json) {
    emitJson({ sessions: sessions.map(toJson) });
    return;
  }

  // Are there hidden sessions the default view is holding back? (Only asked when
  // not already showing everything, so we can point the student at `--all`.)
  const hiddenExist =
    !showHidden && unplacedSessions({ includeHidden: true }).length > sessions.length;

  if (sessions.length === 0) {
    console.log(
      showHidden
        ? 'Inbox empty — no captured sessions are awaiting placement.'
        : "Inbox empty — you're all set.",
    );
    if (!showHidden) printHints(hiddenExist);
    return;
  }

  console.log(
    `${showHidden ? 'All unplaced sessions' : 'Unplaced sessions'} (${sessions.length}):`,
  );
  console.log('');
  const ordered = printGrouped(sessions, showHidden);
  if (!showHidden) {
    printHints(hiddenExist);
    console.log('');
  }

  // Non-interactive: just report and show how to place one by id.
  if (!process.stdin.isTTY) {
    console.log(
      showHidden
        ? 'Place a hidden one:  showtail move <session-id> --to <path>'
        : 'Place one with:  showtail reattach <session-id> --to <path>',
    );
    return;
  }

  const result = await pickSessionsWithAction(
    ordered,
    `Pick sessions to place [e.g. 1,3 or 'all'; 'd1,3'/'dismiss all' to dismiss; q to quit]:`,
  );
  if (!result || result.items.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }

  if (result.action === 'dismiss') {
    for (const session of result.items) dismissLedgerSession(session.id);
    console.log('');
    console.log(
      `Dismissed ${result.items.length} session(s) — still recoverable with 'showtail inbox --all'.`,
    );
    return;
  }

  const toPath = await ask('Place into which project path?', opts.cwd ?? process.cwd());
  for (const session of result.items) {
    const { root, projected } = await reattachLedgerSession(session, toPath);
    console.log(`  ${session.id} → ${root} — ${projected} record(s) projected.`);
  }
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
