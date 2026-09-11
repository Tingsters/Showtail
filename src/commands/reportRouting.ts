import {
  ensureLedgerSegments,
  knownTrailPath,
  listActionableLedgerRanges,
  markLedgerSegmentInbox,
  readLedgerSession,
  trailExistsAt,
  type LedgerRangeView,
  type LedgerTarget,
} from '../core/ledger.ts';
import { ShowtailError } from '../core/errors.ts';
import { removeLedgerSegmentProjection } from '../core/projectionRouting.ts';
import { samePath } from '../core/storage.ts';
import { placeLedgerRangeInProject } from './reattach.ts';

export interface ReroutedRange {
  id: string;
  sessionId: string;
  rangeId: string;
  segmentIds: string[];
  root: string;
  movedFrom: string[];
}

export interface CleanedPendingRange {
  id: string;
  sessionId: string;
  rangeId: string;
  segmentIds: string[];
  reason: 'ambiguous' | 'no-project-evidence';
  removedFrom: string[];
}

export interface ReportRoutingReconciliation {
  reroutedRanges: ReroutedRange[];
  cleanedPendingRanges: CleanedPendingRange[];
  warnings: Array<{ id: string; message: string }>;
}

function recordedTargets(range: LedgerRangeView): LedgerTarget[] {
  return range.segments.flatMap((segment) => segment.targets ?? []);
}

function targetMatchesRoot(target: LedgerTarget, root: string): boolean {
  if (samePath(target.path, root)) {
    return trailExistsAt(root, target.trailId);
  }
  if (trailExistsAt(target.path, target.trailId)) return false;
  const known = knownTrailPath(target.trailId);
  return (
    known !== undefined && samePath(known, root) && trailExistsAt(root, target.trailId)
  );
}

function targetConflictsWithRoot(target: LedgerTarget, root: string): boolean {
  return samePath(target.path, root) && !trailExistsAt(root, target.trailId);
}

function rangeRelatesToRoot(range: LedgerRangeView, root: string): boolean {
  const targets = recordedTargets(range);
  if (targets.some((target) => targetMatchesRoot(target, root))) {
    return true;
  }
  // A folder can be deleted and later initialized as a different project. Its
  // path evidence is not permission to reconcile placements owned by the old ID.
  if (targets.some((target) => targetConflictsWithRoot(target, root))) return false;
  if (range.route.state === 'tracked' || range.route.state === 'candidate') {
    return samePath(range.route.root, root);
  }
  return (
    range.route.state === 'ambiguous' &&
    range.route.candidates.some((candidate) => samePath(candidate, root))
  );
}

function needsDeterministicPlacement(range: LedgerRangeView, root: string): boolean {
  if (range.segment.status !== 'placed' || range.targetMissing) return true;
  const targets = recordedTargets(range);
  if (!targets.some((target) => targetMatchesRoot(target, root))) return true;
  return targets.some((target) => !targetMatchesRoot(target, root));
}

function rangeIdentity(range: LedgerRangeView): {
  id: string;
  sessionId: string;
  rangeId: string;
  segmentIds: string[];
} {
  return {
    id: range.selector,
    sessionId: range.session.id,
    rangeId: range.segment.id,
    segmentIds: [...range.memberSegmentIds],
  };
}

/**
 * Lazily split legacy whole-chat placements before a report reads the trail.
 * Destination writes complete before obsolete source records are removed, so a
 * crash can temporarily duplicate a turn but cannot lose it.
 */
export async function reconcileReportRouting(
  reportRoot: string,
): Promise<ReportRoutingReconciliation> {
  const result: ReportRoutingReconciliation = {
    reroutedRanges: [],
    cleanedPendingRanges: [],
    warnings: [],
  };
  const initialRanges = listActionableLedgerRanges({ includeHidden: true });
  const relatedSessions = new Set(
    initialRanges
      .filter((range) => rangeRelatesToRoot(range, reportRoot))
      .map((range) => range.session.id),
  );

  for (const sessionId of relatedSessions) {
    const session = readLedgerSession(sessionId);
    if (!session) continue;
    const document = ensureLedgerSegments(session);
    if (document.segments.length <= 1) continue;
    const ranges = initialRanges.filter((range) => range.session.id === sessionId);
    const deterministic = ranges.filter(
      (range) => range.route.state === 'tracked' || range.route.state === 'candidate',
    );

    // Snapshot shared legacy targets before any destination-first move mutates them.
    const deterministicTargets = deterministic.flatMap((range) =>
      recordedTargets(range).map((target) => target.path),
    );

    for (const range of deterministic) {
      const destination = range.route.state === 'ambiguous' ? null : range.route.root;
      if (!destination || !needsDeterministicPlacement(range, destination)) continue;
      const beforeTargets = recordedTargets(range).map((target) => target.path);
      try {
        const placed = await placeLedgerRangeInProject(range, destination, undefined, {
          provisionalAuthor: true,
        });
        const movedFrom = [
          ...new Set(
            [...beforeTargets, ...placed.movedFrom].filter(
              (source) => !samePath(source, destination),
            ),
          ),
        ];
        if (movedFrom.length > 0 || !samePath(destination, reportRoot)) {
          result.reroutedRanges.push({
            ...rangeIdentity(range),
            root: destination,
            movedFrom,
          });
        }
      } catch (error) {
        if (error instanceof ShowtailError && error.errorCode === 'DUPLICATE_TRAIL_ID') {
          throw error;
        }
        result.warnings.push({
          id: range.selector,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const range of ranges) {
      if (range.route.state !== 'ambiguous' && range.route.state !== 'none') continue;
      const rangeTargetPaths = recordedTargets(range).map((target) => target.path);
      if (rangeTargetPaths.length === 0) continue;

      const members = range.memberSegmentIds.flatMap((segmentId) => {
        const segment = document.segments.find((candidate) => candidate.id === segmentId);
        return segment ? [segment] : [];
      });
      const explicitlyPlaced = members.some(
        (segment) => segment.migration?.phase === 'complete',
      );
      const sharesLegacyTarget = rangeTargetPaths.some((target) =>
        deterministicTargets.some((deterministicTarget) =>
          samePath(target, deterministicTarget),
        ),
      );
      if (explicitlyPlaced || !sharesLegacyTarget) continue;

      const removedFrom: string[] = [];
      try {
        for (const segment of members) {
          removedFrom.push(
            ...(await removeLedgerSegmentProjection(
              readLedgerSession(sessionId) ?? session,
              segment.id,
            )),
          );
          markLedgerSegmentInbox(sessionId, segment.id, { clearTargets: true });
        }
        result.cleanedPendingRanges.push({
          ...rangeIdentity(range),
          reason: range.route.state === 'ambiguous' ? 'ambiguous' : 'no-project-evidence',
          removedFrom: [...new Set(removedFrom)],
        });
      } catch (error) {
        result.warnings.push({
          id: range.selector,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}
