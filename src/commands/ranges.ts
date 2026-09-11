import {
  listActionableLedgerRanges,
  readLedgerRecords,
  type LedgerRangeView,
} from '../core/ledger.ts';
import { samePath } from '../core/storage.ts';
import { oneLine } from '../core/text.ts';

/** Stable JSON shape shared by report, status, inbox, and editor integrations. */
export interface PendingRangeSummary {
  id: string;
  sessionId: string;
  rangeId: string;
  startedAt: string;
  lastSeenAt: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  prompts: number;
  edits: number;
  reason: string;
  candidates: string[];
}

export function ledgerRangeIsPending(range: LedgerRangeView): boolean {
  return range.segment.status === 'inbox' || range.targetMissing;
}

function routeCandidates(range: LedgerRangeView): string[] {
  if (range.route.state === 'ambiguous') return [...range.route.candidates];
  if (range.route.state === 'tracked' || range.route.state === 'candidate') {
    return [range.route.root];
  }
  return range.targetMissing ? [...range.targetPaths] : [];
}

function rangeReason(range: LedgerRangeView): string {
  if (range.targetMissing) return 'project trail is missing';
  if (range.route.state === 'ambiguous') {
    return range.edits > 0
      ? 'one turn edits multiple project roots'
      : 'multiple project candidates';
  }
  if (range.route.state === 'none') return 'no project evidence';
  if (range.hiddenReason === 'dismissed') return 'dismissed';
  if (range.hiddenReason === 'ignored-path') return 'project path is ignored';
  if (range.hiddenReason === 'low-signal') return 'low-signal captured work';
  return 'awaiting project placement';
}

/** Convert a range view without deriving or persisting any additional ledger state. */
export function pendingRangeSummary(range: LedgerRangeView): PendingRangeSummary {
  const memberIds = new Set(range.segments.flatMap((segment) => segment.recordIds));
  const prompts = readLedgerRecords(range.session.id).flatMap((record) =>
    memberIds.has(record.id) && record.kind === 'prompt' && record.text
      ? [oneLine(record.text, 160)]
      : [],
  );
  return {
    id: range.selector,
    sessionId: range.session.id,
    rangeId: range.segment.id,
    startedAt: range.segment.startedAt,
    lastSeenAt: range.segments.at(-1)?.endedAt ?? range.segment.endedAt,
    firstPrompt: prompts.at(0) ?? null,
    lastPrompt: prompts.at(-1) ?? null,
    prompts: range.prompts,
    edits: range.edits,
    reason: rangeReason(range),
    candidates: routeCandidates(range),
  };
}

function rangeRelatesToRoot(range: LedgerRangeView, root: string): boolean {
  if (range.targetPaths.some((target) => samePath(target, root))) return true;
  if (range.route.state === 'tracked' || range.route.state === 'candidate') {
    return samePath(range.route.root, root);
  }
  return (
    range.route.state === 'ambiguous' &&
    range.route.candidates.some((candidate) => samePath(candidate, root))
  );
}

/**
 * Review ranges related to one project, including unresolved neighbors from the
 * same native chat. This is what keeps an uncertain prefix visible after the
 * clearly owned turns have been split into their projects.
 */
export function pendingRangeSummariesForRoot(
  root: string | null,
  options: { persist?: boolean } = {},
): PendingRangeSummary[] {
  if (!root) return [];
  const ranges = listActionableLedgerRanges({
    includeHidden: true,
    persist: options.persist,
  });
  const relatedSessions = new Set(
    ranges
      .filter((range) => rangeRelatesToRoot(range, root))
      .map((range) => range.session.id),
  );
  return ranges
    .filter(
      (range) => relatedSessions.has(range.session.id) && ledgerRangeIsPending(range),
    )
    .map(pendingRangeSummary);
}
