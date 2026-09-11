/**
 * `showtail move` — relocate one independently routeable work range from one
 * project folder to another.
 *
 * With no id it lists every ledger range (placed, inbox, or target-missing) and
 * interactively moves the chosen one(s). `move <range-id> --to <path>` is the
 * scriptable form. A legacy bare session id remains accepted only when that
 * session currently has exactly one actionable range.
 */
import { ShowtailError } from '../core/errors.ts';
import {
  allLedgerSessionViews,
  listActionableLedgerRanges,
  resolveLedgerRangeSelector,
  resolveLedgerSessionId,
  type LedgerRangeView,
  type LedgerSessionView,
} from '../core/ledger.ts';
import { emitJson } from '../core/output.ts';
import { prepareCandidateIndex, type CandidateIndex } from '../core/relocate.ts';
import { oneLine } from '../core/text.ts';
import { placeLedgerRangeInProject, stubNote } from './reattach.ts';
import { ask, pickSessions, relativeTime, summarize } from './sessionPicker.ts';

/** A one-line status/location label for a range. */
function location(range: LedgerRangeView): string {
  if (range.segment.status === 'inbox') return '[inbox]';
  if (range.targetMissing) {
    return `[target missing]${range.targetPaths[0] ? ` (was ${range.targetPaths[0]})` : ''}`;
  }
  return range.targetPaths.length > 0 ? `→ ${range.targetPaths.join(', ')}` : '[placed]';
}

function rangeLastSeenAt(range: LedgerRangeView): string {
  return range.segments.at(-1)?.endedAt ?? range.segment.endedAt;
}

/** Print one range as the numbered block shown in the listing / picker. */
function printRange(range: LedgerRangeView, ordinal: number): void {
  console.log(
    `  ${ordinal}. ${relativeTime(rangeLastSeenAt(range))}    ${range.prompts} prompt(s), ${range.edits} edit(s) · ${range.session.tool}   ${location(range)}`,
  );
  if (range.firstPrompt) console.log(`     first: ${oneLine(range.firstPrompt, 100)}`);
  console.log(`     id: ${range.selector}`);
  console.log('');
}

/** Legacy machine-readable session shape retained for existing consumers. */
function sessionJson(session: LedgerSessionView): Record<string, unknown> {
  const { prompts, edits, firstPrompt } = summarize(session.id);
  return {
    id: session.id,
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    status: session.targetMissing ? 'target-missing' : session.status,
    paths: session.targetPaths,
    cwd: session.cwd ?? null,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    prompts,
    edits,
    firstPrompt: firstPrompt ?? null,
  };
}

/** Authoritative machine-readable shape for one independently movable range. */
function rangeJson(range: LedgerRangeView): Record<string, unknown> {
  return {
    id: range.selector,
    sessionId: range.session.id,
    rangeId: range.segment.id,
    memberSegmentIds: range.memberSegmentIds,
    tool: range.session.tool,
    nativeSessionId: range.session.nativeSessionId,
    status: range.targetMissing ? 'target-missing' : range.segment.status,
    paths: range.targetPaths,
    cwd: range.session.cwd ?? null,
    startedAt: range.segment.startedAt,
    lastSeenAt: rangeLastSeenAt(range),
    prompts: range.prompts,
    edits: range.edits,
    firstPrompt: range.firstPrompt ?? null,
    hiddenReason: range.hiddenReason,
  };
}

function sessionRangeError(sessionId: string, ranges: LedgerRangeView[]): ShowtailError {
  const rangeIds = ranges.map((range) => range.selector);
  return new ShowtailError(
    `Session ${sessionId} does not identify exactly one independently movable work range. Choose a range id from \`showtail move --json\`.`,
    2,
    { sessionId, rangeIds, ranges: ranges.map(rangeJson) },
    'SESSION_HAS_MULTIPLE_SEGMENTS',
    'choose-work-range',
  );
}

/** Resolve a range selector, with backwards compatibility for one-range sessions. */
function resolveMoveRange(selector: string): LedgerRangeView {
  const range = resolveLedgerRangeSelector(selector);
  if (range) return range;

  // Segment/range selectors contain a colon. Only a bare id gets the legacy
  // whole-session lookup, and it is safe only when there is one possible range.
  if (!selector.includes(':')) {
    const session = resolveLedgerSessionId(selector);
    if (session) {
      const ranges = listActionableLedgerRanges({
        includeHidden: true,
        sessionId: session.id,
      });
      if (ranges.length !== 1) throw sessionRangeError(session.id, ranges);
      return ranges[0]!;
    }
  }

  throw new Error(
    `No ledger work range matching "${selector}". Run \`showtail move\` to list ranges.`,
  );
}

/** Move one range to `toPath`, printing the outcome. */
async function moveOne(
  range: LedgerRangeView,
  toPath: string,
  index?: CandidateIndex,
): Promise<void> {
  const { root, projected, movedFrom, stubs } = await placeLedgerRangeInProject(
    range,
    toPath,
    index,
  );
  if (movedFrom.length > 0) {
    console.log(`Moved ${range.selector} off ${movedFrom.join(', ')}.`);
  }
  console.log(
    `Placed ${range.selector} into ${root} — ${projected} record(s) projected.`,
  );
  stubNote(stubs);
}

/** CLI entry point for `showtail move`. */
export async function runMove(
  selector: string | undefined,
  opts: { to?: string; json?: boolean; cwd?: string } = {},
): Promise<void> {
  // Scriptable form: a range selector or backwards-compatible one-range session id.
  if (selector) {
    const range = resolveMoveRange(selector);
    await moveOne(range, opts.to ?? opts.cwd ?? process.cwd());
    console.log('Run `showtail report` there to see it alongside your other work.');
    return;
  }

  const readOnlyListing = opts.json === true;
  const sessions = allLedgerSessionViews({ repairTargets: !readOnlyListing });
  const ranges = listActionableLedgerRanges({
    includeHidden: true,
    ...(readOnlyListing ? { persist: false } : {}),
  });

  if (opts.json) {
    emitJson({
      sessions: sessions.map(sessionJson),
      ranges: ranges.map(rangeJson),
    });
    return;
  }

  if (ranges.length === 0) {
    console.log('No captured work ranges yet.');
    return;
  }

  console.log(`Work ranges (${ranges.length}):`);
  console.log('');
  ranges.forEach((range, index) => printRange(range, index + 1));

  // Non-interactive: list and show how to move by range id.
  if (!process.stdin.isTTY) {
    console.log('Move one with:  showtail move <range-id> --to <path>');
    return;
  }

  const chosen = await pickSessions(
    ranges,
    `Move which work range(s)? [e.g. 2, q to quit]:`,
  );
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }
  const toPath = await ask('Move into which project path?', opts.cwd ?? process.cwd());
  // One destination for the whole batch, so walk and hash it once.
  const index = prepareCandidateIndex(toPath);
  for (const range of chosen) await moveOne(range, toPath, index);
  console.log('');
  console.log('Run `showtail report` there to see them alongside your other work.');
}
