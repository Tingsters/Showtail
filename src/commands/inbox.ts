/**
 * `showtail inbox` — the unplaced-session tray. By default it lists only sessions
 * worth placing: signal-bearing work the ledger could resolve to a candidate project
 * but could not place (plus any whose target trail has gone missing). Unresolved,
 * trivial, ignored, or dismissed work stays in the ledger; `showtail inbox --all`
 * reveals it, tagged with why.
 *
 * On a terminal it doubles as a picker: choose sessions and the repo to place them in
 * (reattach), or dismiss them from the default view (`d1,3` / `dismiss all`). Without a
 * TTY (or with `--json`) it just reports, so scripts/agents can drive `reattach`/`move`.
 */
import { emitJson } from '../core/output.ts';
import {
  dismissLedgerRange,
  effectiveLedgerPath,
  hiddenReason,
  listActionableLedgerRanges,
  unplacedSessions,
  type HiddenReason,
  type LedgerRangeView,
  type LedgerSession,
} from '../core/ledger.ts';
import { prepareCandidateIndex } from '../core/relocate.ts';
import { placeLedgerRangeInProject, stubNote } from './reattach.ts';
import { pendingRangeSummary } from './ranges.ts';
import { ask, pickSessionsWithAction, relativeTime, summarize } from './sessionPicker.ts';

type Unplaced = LedgerSession & { targetMissing?: boolean; pathGone?: boolean };

/**
 * One calm pointer to `--help` — the single home for the flag/command docs. We do NOT
 * repeat `--all` inline here: it's already listed under Options in `showtail inbox --help`,
 * and echoing it in the plain command output is redundant.
 */
const HELP_HINT = "'showtail inbox --help' lists all inbox commands.";

/** Human tag for why a session is hidden (only shown in the `--all` view). */
const REASON_TAG: Record<HiddenReason, string> = {
  dismissed: '[dismissed]',
  'not-in-project': '[unresolved: no project path]',
  'low-signal': '[filtered: low signal]',
  'ignored-path': '[filtered: ignored path]',
};

/** Machine-readable shape for `--json`. */
function toJson(session: Unplaced): Record<string, unknown> {
  const { prompts, edits, firstPrompt } = summarize(session.id);
  return {
    id: session.id,
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    cwd:
      typeof session.cwd === 'string'
        ? effectiveLedgerPath(session, session.cwd)
        : (session.cwd ?? null),
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    status: session.targetMissing ? 'target-missing' : 'inbox',
    hiddenReason: session.targetMissing ? null : hiddenReason(session),
    pathGone: session.pathGone ?? false,
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

function rangeTag(range: LedgerRangeView, showHidden: boolean): string {
  if (range.targetMissing) return '  [target missing]';
  if (!showHidden || !range.hiddenReason) return '';
  return `  ${REASON_TAG[range.hiddenReason]}`;
}

function printRange(range: LedgerRangeView, ordinal: number, showHidden: boolean): void {
  const summary = pendingRangeSummary(range);
  console.log(
    `  ${ordinal}. ${relativeTime(summary.lastSeenAt)}    ${summary.prompts} prompt(s), ${summary.edits} edit(s) · ${range.session.tool}${rangeTag(range, showHidden)}`,
  );
  if (summary.firstPrompt) console.log(`     first: ${summary.firstPrompt}`);
  console.log(`     reason: ${summary.reason}`);
  if (summary.candidates.length > 0) {
    console.log(`     projects: ${summary.candidates.join(', ')}`);
  }
  console.log(`     id: ${summary.id}`);
  console.log('');
}

function rangeJson(range: LedgerRangeView): Record<string, unknown> {
  return {
    ...pendingRangeSummary(range),
    tool: range.session.tool,
    nativeSessionId: range.session.nativeSessionId,
    status: range.targetMissing ? 'target-missing' : range.segment.status,
    paths: range.targetPaths,
    hiddenReason: range.hiddenReason,
    memberSegmentIds: range.memberSegmentIds,
  };
}

function printGroupedRanges(
  ranges: LedgerRangeView[],
  showHidden: boolean,
): LedgerRangeView[] {
  const groups = new Map<string, LedgerRangeView[]>();
  for (const range of ranges) {
    const key = `${range.session.tool} chat ${range.session.nativeSessionId}`;
    const group = groups.get(key);
    if (group) group.push(range);
    else groups.set(key, [range]);
  }
  const ordered: LedgerRangeView[] = [];
  let ordinal = 0;
  for (const [chat, items] of groups) {
    console.log(`  ${chat}`);
    for (const range of items) {
      ordinal += 1;
      printRange(range, ordinal, showHidden);
      ordered.push(range);
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
  const ranges = listActionableLedgerRanges({
    includeHidden: showHidden,
    pendingOnly: true,
  });

  if (opts.json) {
    emitJson({
      sessions: sessions.map(toJson),
      ranges: ranges.map(rangeJson),
    });
    return;
  }

  if (ranges.length === 0) {
    console.log(
      showHidden
        ? 'Inbox empty — no captured work ranges are awaiting placement.'
        : "Inbox empty — you're all set.",
    );
    if (!showHidden) console.log(HELP_HINT);
    return;
  }

  console.log(
    `${showHidden ? 'All unplaced work ranges' : 'Unplaced work ranges'} (${ranges.length}):`,
  );
  console.log('');
  const ordered = printGroupedRanges(ranges, showHidden);
  if (!showHidden) {
    console.log(HELP_HINT);
    console.log('');
  }

  // Non-interactive: just report and show how to place one by id.
  if (!process.stdin.isTTY) {
    console.log(
      showHidden
        ? 'Place a hidden one:  showtail move <range-id> --to <path>'
        : 'Place one with:  showtail move <range-id> --to <path>',
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
    for (const range of result.items) dismissLedgerRange(range.session.id, range);
    console.log('');
    console.log(
      `Dismissed ${result.items.length} work range(s) — still recoverable with 'showtail inbox --all'.`,
    );
    return;
  }

  const toPath = await ask('Place into which project path?', opts.cwd ?? process.cwd());
  // One destination for the whole batch, so the folder is walked and hashed once.
  const index = prepareCandidateIndex(toPath);
  for (const range of result.items) {
    const { root, projected, stubs } = await placeLedgerRangeInProject(
      range,
      toPath,
      index,
    );
    console.log(`  ${range.selector} -> ${root} — ${projected} record(s) projected.`);
    stubNote(stubs);
  }
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
