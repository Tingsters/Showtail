/** Keep a ledger session projected into only the project that currently owns it. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorSlugs } from './authors.ts';
import { CaptureInterruptedError, requireCaptureContinuation } from './captureGuard.ts';
import { removeEventsByBatch, removeJournalEntriesBySourceIds } from './events.ts';
import { ensureMachineId } from './identity.ts';
import { readJournal } from './journal.ts';
import {
  ensureLedgerSegments,
  knownTrailPath,
  ledgerRecordProjectionSourceId,
  markLedgerSegmentPlaced,
  readLedgerSession,
  readLedgerSegmentRecords,
  setLedgerSegmentMigration,
  trailExistsAt,
  unlinkLedgerSegmentPlacement,
  unlinkPlacement,
  type LedgerSegment,
  type LedgerSegmentMigration,
  type LedgerSession,
} from './ledger.ts';
import {
  ledgerBatchId,
  ledgerSegmentBatchId,
  materializeLedgerSegment,
  type MaterializeOptions,
  type MaterializeResult,
} from './materialize.ts';
import { pruneProvisionalTrail } from './provisionalTrail.ts';
import {
  authorPaths,
  pathsForRoot,
  readSessions,
  readState,
  samePath,
  writeSessions,
  writeState,
  type AuthorPaths,
} from './storage.ts';
import type { JournalEntry } from '../types.ts';

export interface ProjectionRoutingOptions {
  /** Automatic callers abort when their original capture-consent epoch changes. */
  continueCapture?: () => boolean;
}

/** Remove only session metadata left empty by deleting one ledger batch. */
function removeVacatedSessions(
  author: AuthorPaths,
  nativeSessionId: string,
  removedEntries: JournalEntry[],
): void {
  const projectedSessionIds = new Set(
    removedEntries.flatMap((entry) => (entry.conv ? [entry.conv] : [])),
  );
  const remainingEntries = readJournal(author);
  const referencedSessionIds = new Set(
    remainingEntries.flatMap((entry) => (entry.conv ? [entry.conv] : [])),
  );
  const sessions = readSessions(author);
  const removedSessions = sessions.filter(
    (session) =>
      session.nativeSessionId === nativeSessionId &&
      projectedSessionIds.has(session.id) &&
      !referencedSessionIds.has(session.id),
  );

  const removedSessionIds = new Set(removedSessions.map((session) => session.id));
  const retainedSessions = sessions.filter(
    (session) => !removedSessionIds.has(session.id),
  );
  const owningMachineIds = new Set(
    removedSessions.flatMap((session) => (session.machineId ? [session.machineId] : [])),
  );
  for (const machineId of owningMachineIds) {
    writeSessions(authorPaths(author.shared, author.slug, machineId), retainedSessions);
  }

  const removedEntryIds = new Set(removedEntries.map((entry) => entry.id));
  const state = readState(author.shared);
  let stateChanged = false;
  if (state.currentSessionId && removedSessionIds.has(state.currentSessionId)) {
    state.currentSessionId = null;
    state.currentPromptId = null;
    stateChanged = true;
  } else if (state.currentPromptId && removedEntryIds.has(state.currentPromptId)) {
    state.currentPromptId = null;
    stateChanged = true;
  }
  if (state.turnByNativeSession) {
    const nextTurns = { ...state.turnByNativeSession };
    for (const [nativeId, promptId] of Object.entries(nextTurns)) {
      if (removedEntryIds.has(promptId)) {
        delete nextTurns[nativeId];
        stateChanged = true;
      }
    }
    if (stateChanged) state.turnByNativeSession = nextTurns;
  }
  if (stateChanged) {
    writeState(author.shared, state);
  }
}

interface PreparedAuthorCleanup {
  author: AuthorPaths;
  batchEntries: JournalEntry[];
}

function sourceIdsForSegment(
  session: LedgerSession,
  segment: LedgerSegment,
): Set<string> {
  return new Set(
    readLedgerSegmentRecords(session.id, segment).map((record) =>
      ledgerRecordProjectionSourceId(session.id, record),
    ),
  );
}

function projectionTargetRoot(target: { trailId: string; path: string }): string {
  if (trailExistsAt(target.path, target.trailId)) return target.path;
  const known = knownTrailPath(target.trailId);
  return known && trailExistsAt(known, target.trailId) ? known : target.path;
}

/** Remove one turn's exact source-id set from one recorded target. */
function removeSegmentAtTarget(
  session: LedgerSession,
  segment: LedgerSegment,
  target: { trailId: string; path: string },
  options: ProjectionRoutingOptions,
): { root: string; removed: number } {
  const oldRoot = projectionTargetRoot(target);
  const sourceIds = sourceIdsForSegment(session, segment);
  const prepared: Array<{ author: AuthorPaths; entries: JournalEntry[] }> = [];
  if (existsSync(join(oldRoot, '.showtail', 'config.json'))) {
    const oldPaths = pathsForRoot(oldRoot);
    const machineId = session.machineId ?? ensureMachineId();
    for (const slug of authorSlugs(oldPaths)) {
      const author = authorPaths(oldPaths, slug, machineId);
      prepared.push({
        author,
        entries: readJournal(author).filter(
          (entry) => entry.sourceId !== undefined && sourceIds.has(entry.sourceId),
        ),
      });
    }
  }

  // Prepare every affected shard before the first rewrite. Once cleanup begins,
  // finish this target and unlink it as one idempotent consistency unit.
  requireCaptureContinuation(options.continueCapture);
  let removed = 0;
  for (const { author, entries } of prepared) {
    const count = removeJournalEntriesBySourceIds(
      author,
      sourceIds,
      ledgerSegmentBatchId(session.id, segment.id),
    );
    removed += count;
    if (count > 0) removeVacatedSessions(author, session.nativeSessionId, entries);
  }
  unlinkLedgerSegmentPlacement(session.id, segment.id, target.trailId);
  return { root: oldRoot, removed };
}

/**
 * Remove one independently routed turn from every obsolete trail. Neighboring
 * turns in the same native chat remain untouched, including their repo-session
 * metadata and aggregate placement cache.
 */
export async function removeLedgerSegmentProjection(
  session: LedgerSession,
  segmentOrId: LedgerSegment | string,
  keepTrailId?: string,
  options: ProjectionRoutingOptions = {},
): Promise<string[]> {
  requireCaptureContinuation(options.continueCapture);
  const document = ensureLedgerSegments(session, {
    continueCapture: options.continueCapture,
  });
  const segmentId = typeof segmentOrId === 'string' ? segmentOrId : segmentOrId.id;
  let segment = document.segments.find((item) => item.id === segmentId);
  if (!segment) return [];
  const movedFrom: string[] = [];

  for (const target of [...(segment.targets ?? [])]) {
    requireCaptureContinuation(options.continueCapture);
    if (target.trailId === keepTrailId) continue;
    const oldRoot = projectionTargetRoot(target);

    // A provisional trail may be deleted only when this is the session's sole
    // turn. Otherwise pruning it would erase neighboring segments too.
    if (document.segments.length === 1) {
      try {
        const result = await pruneProvisionalTrail({
          root: oldRoot,
          ledgerSessionId: session.id,
          continueCapture: options.continueCapture,
        });
        if (result.pruned && result.trailId) {
          unlinkLedgerSegmentPlacement(session.id, segment.id, result.trailId);
          movedFrom.push(oldRoot);
          segment =
            ensureLedgerSegments(session.id).segments.find(
              (item) => item.id === segmentId,
            ) ?? segment;
          continue;
        }
      } catch (error) {
        if (error instanceof CaptureInterruptedError) throw error;
        // Conservative prune refusal falls through to source-id cleanup.
      }
    }

    const cleaned = removeSegmentAtTarget(session, segment, target, options);
    if (cleaned.removed > 0) movedFrom.push(cleaned.root);
    segment =
      ensureLedgerSegments(session.id).segments.find((item) => item.id === segmentId) ??
      segment;
  }
  return [...new Set(movedFrom)];
}

/** Public command vocabulary alias. */
export const removeLedgerRangeProjection = removeLedgerSegmentProjection;

export interface LedgerSegmentReprojectionOptions
  extends MaterializeOptions, ProjectionRoutingOptions {
  /** Test/diagnostic hook called only after a phase is durably persisted. */
  onPhase?: (phase: LedgerSegmentMigration['phase']) => void | Promise<void>;
}

export interface LedgerSegmentReprojectionResult {
  materialized: MaterializeResult;
  movedFrom: string[];
  phase: LedgerSegmentMigration['phase'];
}

function sameDestination(
  migration: LedgerSegmentMigration | undefined,
  trailId: string,
  root: string,
): boolean {
  return (
    migration?.destination.trailId === trailId &&
    samePath(migration.destination.path, root)
  );
}

/**
 * Destination-first, crash-idempotent reprojection for one turn. A retry may
 * temporarily observe both copies, but never removes the old copy before the
 * destination has the complete source-id set.
 */
export async function reprojectLedgerSegment(
  session: LedgerSession,
  segmentOrId: LedgerSegment | string,
  author: AuthorPaths,
  trailId: string,
  root: string,
  options: LedgerSegmentReprojectionOptions = {},
): Promise<LedgerSegmentReprojectionResult> {
  const segmentId = typeof segmentOrId === 'string' ? segmentOrId : segmentOrId.id;
  let segment = ensureLedgerSegments(session).segments.find(
    (candidate) => candidate.id === segmentId,
  );
  if (!segment) {
    return {
      materialized: await materializeLedgerSegment(session, segmentId, author, options),
      movedFrom: [],
      phase: 'complete',
    };
  }

  let migration = segment.migration;
  if (!sameDestination(migration, trailId, root)) {
    const now = new Date().toISOString();
    migration = {
      phase: 'planned',
      destination: { trailId, path: root },
      sourceTargets: (segment.targets ?? [])
        .filter((target) => target.trailId !== trailId)
        .map((target) => ({ ...target })),
      startedAt: now,
      updatedAt: now,
    };
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    await options.onPhase?.('planned');
  }
  if (!migration) {
    throw new Error(`Unable to initialize ledger segment migration: ${segment.id}`);
  }

  const materialized = await materializeLedgerSegment(
    session,
    segment.id,
    author,
    options,
  );
  if (!materialized.completed) {
    return { materialized, movedFrom: [], phase: migration.phase };
  }
  if (migration.phase === 'complete') {
    return { materialized, movedFrom: [], phase: 'complete' };
  }
  if (migration.phase === 'planned') {
    migration = {
      ...migration,
      phase: 'destination-materialized',
      updatedAt: new Date().toISOString(),
    };
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    await options.onPhase?.('destination-materialized');
  }

  markLedgerSegmentPlaced(session.id, segment.id, trailId, root, {
    continueCapture: options.continueCapture,
    pathRebase: options.rebase,
  });
  const current = readLedgerSession(session.id) ?? session;
  const movedFrom = await removeLedgerSegmentProjection(
    current,
    segment.id,
    trailId,
    options,
  );
  migration = {
    ...migration,
    phase: 'obsolete-projections-removed',
    updatedAt: new Date().toISOString(),
  };
  setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  await options.onPhase?.('obsolete-projections-removed');

  migration = {
    ...migration,
    phase: 'complete',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  await options.onPhase?.('complete');
  return { materialized, movedFrom, phase: 'complete' };
}

/** Public command vocabulary alias. */
export const reprojectLedgerRange = reprojectLedgerSegment;

/**
 * Remove this session's projection from every trail except `keepTrailId`.
 * The ledger remains the source of truth, so a later materialization recreates
 * the complete session in the correct project without losing captured work.
 */
export function removeOtherLedgerProjections(
  session: LedgerSession,
  keepTrailId?: string,
  options: ProjectionRoutingOptions = {},
): string[] {
  requireCaptureContinuation(options.continueCapture);
  const document = ensureLedgerSegments(session, {
    continueCapture: options.continueCapture,
  });
  if (document.segments.length > 0) {
    const movedFrom: string[] = [];
    for (const segment of document.segments) {
      for (const target of [...(segment.targets ?? [])]) {
        requireCaptureContinuation(options.continueCapture);
        if (target.trailId === keepTrailId) continue;
        const cleaned = removeSegmentAtTarget(session, segment, target, options);
        if (cleaned.removed > 0) movedFrom.push(cleaned.root);
      }
    }
    return [...new Set(movedFrom)];
  }

  // Empty/pre-segmentation compatibility fallback.
  const movedFrom: string[] = [];
  for (const target of session.targets ?? []) {
    requireCaptureContinuation(options.continueCapture);
    if (target.trailId === keepTrailId) continue;
    const oldRoot = projectionTargetRoot(target);
    const prepared: PreparedAuthorCleanup[] = [];
    const batchId = ledgerBatchId(session.id);
    if (existsSync(join(oldRoot, '.showtail', 'config.json'))) {
      const oldPaths = pathsForRoot(oldRoot);
      const machineId = session.machineId ?? ensureMachineId();
      // Identity can be upgraded after the first projection. Search every author
      // partition so an obsolete ledger batch cannot survive under the old slug.
      for (const slug of authorSlugs(oldPaths)) {
        const author = authorPaths(oldPaths, slug, machineId);
        prepared.push({
          author,
          batchEntries: readJournal(author).filter((entry) => entry.batch === batchId),
        });
      }
    }

    // Everything above is read-only preparation. Once the first journal rewrite
    // starts, finish this target's journal/session/state/placement cleanup as one
    // consistency unit. Re-checking consent between those writes could strand a
    // half-removed projection; a later target remains a separate interrupt point.
    requireCaptureContinuation(options.continueCapture);
    let removed = 0;
    for (const { author, batchEntries } of prepared) {
      const removedFromAuthor = removeEventsByBatch(author, batchId);
      removed += removedFromAuthor;
      if (removedFromAuthor > 0) {
        removeVacatedSessions(author, session.nativeSessionId, batchEntries);
      }
    }
    if (removed > 0) movedFrom.push(oldRoot);
    unlinkPlacement(session.id, target.trailId);
  }
  return movedFrom;
}

/**
 * Clear obsolete placements, deleting a pristine automatic trail only when its
 * initialization provenance proves this ledger session created it. Any refusal
 * falls back to removing just this session's projection from the existing trail.
 */
export async function clearOtherLedgerProjections(
  session: LedgerSession,
  keepTrailId?: string,
  options: ProjectionRoutingOptions = {},
): Promise<string[]> {
  requireCaptureContinuation(options.continueCapture);
  const document = ensureLedgerSegments(session, {
    continueCapture: options.continueCapture,
  });
  if (document.segments.length > 0) {
    const cleared: string[] = [];
    for (const segment of document.segments) {
      cleared.push(
        ...(await removeLedgerSegmentProjection(
          readLedgerSession(session.id) ?? session,
          segment.id,
          keepTrailId,
          options,
        )),
      );
    }
    return [...new Set(cleared)];
  }

  // Empty/pre-segmentation compatibility fallback.
  const clearedFrom: string[] = [];
  for (const target of session.targets ?? []) {
    requireCaptureContinuation(options.continueCapture);
    if (target.trailId === keepTrailId) continue;
    const oldRoot = projectionTargetRoot(target);
    try {
      const result = await pruneProvisionalTrail({
        root: oldRoot,
        ledgerSessionId: session.id,
        continueCapture: options.continueCapture,
      });
      if (result.pruned && result.trailId) {
        // Pruning is the destructive half of one commit. Once it succeeds, the
        // placement must be removed even if consent changes before this promise
        // resumes; otherwise the ledger points at a trail that no longer exists.
        unlinkPlacement(session.id, result.trailId);
        clearedFrom.push(oldRoot);
      }
    } catch (error) {
      if (error instanceof CaptureInterruptedError) throw error;
      // Conservative prune refusal/failure falls through to projection removal.
    }
  }
  const current = readLedgerSession(session.id) ?? session;
  const hasRemainingProjection = (current.targets ?? []).some(
    (target) => target.trailId !== keepTrailId,
  );
  if (!hasRemainingProjection) return clearedFrom;
  return [
    ...new Set([
      ...clearedFrom,
      ...removeOtherLedgerProjections(current, keepTrailId, options),
    ]),
  ];
}
