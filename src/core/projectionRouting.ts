/** Keep a ledger session projected into only the project that currently owns it. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorSlugs } from './authors.ts';
import { CaptureInterruptedError, requireCaptureContinuation } from './captureGuard.ts';
import { removeEventsByBatch, removeJournalEntriesBySourceIds } from './events.ts';
import { readGlobalConfig } from './globalConfig.ts';
import { ensureMachineId } from './identity.ts';
import { readJournal } from './journal.ts';
import {
  ensureLedgerSegments,
  effectiveLedgerRecords,
  knownTrailPath,
  ledgerRecordProjectionSourceId,
  markLedgerSegmentPlaced,
  readLedgerSession,
  readLedgerRecords,
  readLedgerSegmentRecords,
  setLedgerSegmentMigration,
  trailExistsAt,
  unlinkLedgerSegmentPlacement,
  unlinkPlacement,
  type LedgerSegment,
  type LedgerSegmentMigration,
  type LedgerSession,
  type LedgerTarget,
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
  /** Test/diagnostic seam after target discovery and before segment cleanup. */
  onBeforeProjectionCleanup?: (
    segmentId: string,
    target: LedgerTarget,
  ) => void | Promise<void>;
  /** Test/diagnostic seam before the pre-segmentation cleanup commit. */
  onBeforeLegacyProjectionCommit?: (target: LedgerTarget) => void;
}

/** Automatic reprojection cannot distinguish two trail identities at one path. */
export class ProjectionIdentityConflictError extends Error {
  readonly code = 'SAME_PATH_TRAIL_ID_CONFLICT';

  constructor(
    readonly sourceTrailId: string,
    readonly destinationTrailId: string,
    readonly root: string,
  ) {
    super(
      `Cannot reproject ${sourceTrailId} into ${destinationTrailId}: both identities resolve to ${root}.`,
    );
    this.name = 'ProjectionIdentityConflictError';
  }
}

/** A recorded placement now points at a path stamped with another trail id. */
export class ProjectionTargetIdentityMismatchError extends Error {
  readonly code = 'PROJECTION_TARGET_IDENTITY_MISMATCH';

  constructor(
    readonly expectedTrailId: string,
    readonly root: string,
  ) {
    super(`Cannot remove ${expectedTrailId}: ${root} now contains another trail.`);
    this.name = 'ProjectionTargetIdentityMismatchError';
  }
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
  const config = readGlobalConfig();
  const candidates = [
    knownTrailPath(target.trailId),
    config.projectCatalog?.byTrailId[target.trailId]?.currentPath,
    ...(config.knownProjects ?? [])
      .filter((project) => project.trailId === target.trailId)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((project) => project.path),
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        candidate !== undefined && trailExistsAt(candidate, target.trailId),
    ) ?? target.path
  );
}

function targetMentionsRoot(
  target: { trailId: string; path: string },
  root: string,
): boolean {
  if (samePath(target.path, root)) return true;
  const known = knownTrailPath(target.trailId);
  return known !== undefined && samePath(known, root);
}

function assertDistinctProjectionIdentities(
  sourceTargets: Array<{ trailId: string; path: string }>,
  destinationTrailId: string,
  destinationRoot: string,
  allowStaleSamePathSource = false,
): void {
  const conflict = sourceTargets.find(
    (target) =>
      target.trailId !== destinationTrailId &&
      targetMentionsRoot(target, destinationRoot),
  );
  if (conflict) {
    if (
      allowStaleSamePathSource &&
      trailExistsAt(destinationRoot, destinationTrailId) &&
      !trailExistsAt(destinationRoot, conflict.trailId)
    ) {
      return;
    }
    throw new ProjectionIdentityConflictError(
      conflict.trailId,
      destinationTrailId,
      destinationRoot,
    );
  }
}

type ProjectionTargetCleanupIdentity = 'matching' | 'missing' | 'stale-same-path';

interface ProjectionTargetCleanupOptions extends ProjectionRoutingOptions {
  allowStaleSamePathSource?: boolean;
  destination?: LedgerTarget;
  /** Reprojection cleanup may remove only IDs proven handled at the destination. */
  provenSourceIds?: ReadonlySet<string>;
}

function projectionTargetCleanupIdentity(
  target: LedgerTarget,
  root: string,
  options: ProjectionTargetCleanupOptions,
): ProjectionTargetCleanupIdentity {
  if (trailExistsAt(root, target.trailId)) return 'matching';
  if (!existsSync(join(root, '.showtail', 'config.json'))) return 'missing';
  const destination = options.destination;
  if (
    options.allowStaleSamePathSource &&
    destination &&
    target.trailId !== destination.trailId &&
    samePath(root, destination.path) &&
    trailExistsAt(destination.path, destination.trailId)
  ) {
    return 'stale-same-path';
  }
  throw new ProjectionTargetIdentityMismatchError(target.trailId, root);
}

function projectionContainsSourceIds(
  session: LedgerSession,
  root: string,
  sourceIds: ReadonlySet<string>,
): boolean {
  if (sourceIds.size === 0) return false;
  const paths = pathsForRoot(root);
  const machineId = session.machineId ?? ensureMachineId();
  return authorSlugs(paths).some((slug) =>
    readJournal(authorPaths(paths, slug, machineId)).some(
      (entry) => entry.sourceId !== undefined && sourceIds.has(entry.sourceId),
    ),
  );
}

/** Remove one turn's exact source-id set from one recorded target. */
function removeSegmentAtTarget(
  session: LedgerSession,
  segment: LedgerSegment,
  target: { trailId: string; path: string },
  options: ProjectionTargetCleanupOptions,
): { root: string; removed: number; remaining: boolean } {
  requireCaptureContinuation(options.continueCapture);
  const oldRoot = projectionTargetRoot(target);
  const cleanupIdentity = projectionTargetCleanupIdentity(target, oldRoot, options);
  const sourceIds = options.provenSourceIds
    ? new Set(options.provenSourceIds)
    : sourceIdsForSegment(session, segment);
  const prepared: Array<{ author: AuthorPaths; entries: JournalEntry[] }> = [];
  // A reused path may now contain an unrelated trail. Never rewrite that trail's
  // journal merely because the stale placement still names the same directory.
  if (cleanupIdentity === 'matching') {
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
  const commitRoot = projectionTargetRoot(target);
  if (!samePath(commitRoot, oldRoot)) {
    throw new Error(
      `Projection target ${target.trailId} moved from ${oldRoot} to ${commitRoot} while cleaning; retry.`,
    );
  }
  const commitIdentity = projectionTargetCleanupIdentity(target, commitRoot, options);
  if (commitIdentity !== cleanupIdentity) {
    throw new Error(
      `Projection target ${target.trailId} changed while cleaning ${oldRoot}; retry.`,
    );
  }
  let removed = 0;
  for (const { author, entries } of prepared) {
    const writeRoot = projectionTargetRoot(target);
    if (!samePath(writeRoot, commitRoot)) {
      throw new Error(
        `Projection target ${target.trailId} moved from ${commitRoot} to ${writeRoot} while cleaning; retry.`,
      );
    }
    projectionTargetCleanupIdentity(target, writeRoot, options);
    const count = removeJournalEntriesBySourceIds(
      author,
      sourceIds,
      ledgerSegmentBatchId(session.id, segment.id),
    );
    removed += count;
    if (count > 0) removeVacatedSessions(author, session.nativeSessionId, entries);
  }

  const latestSegment = currentSegment(session.id, segment.id) ?? segment;
  const remainingRoot = projectionTargetRoot(target);
  if (!samePath(remainingRoot, commitRoot)) {
    throw new Error(
      `Projection target ${target.trailId} moved from ${commitRoot} to ${remainingRoot} while cleaning; retry.`,
    );
  }
  const remainingIdentity = projectionTargetCleanupIdentity(
    target,
    remainingRoot,
    options,
  );
  const remainingSourceIds = sourceIdsForSegment(session, latestSegment);
  const sourceMembershipChanged = !sameSourceIds(
    [...sourceIds].sort(),
    [...remainingSourceIds].sort(),
  );
  const remaining =
    sourceMembershipChanged ||
    (remainingIdentity === 'matching' &&
      projectionContainsSourceIds(session, remainingRoot, remainingSourceIds));
  if (
    !remaining &&
    (latestSegment.targets ?? []).some(
      (candidate) => candidate.trailId === target.trailId,
    )
  ) {
    unlinkLedgerSegmentPlacement(session.id, latestSegment.id, target.trailId);
  }
  return { root: oldRoot, removed, remaining };
}

function mergeProjectionTargets(
  ...groups: ReadonlyArray<readonly LedgerTarget[]>
): LedgerTarget[] {
  const byTrailId = new Map<string, LedgerTarget>();
  for (const group of groups) {
    for (const target of group) {
      // A trail id is the durable identity. Later observations replace a stale
      // locator instead of creating two logical sources for one moved trail.
      byTrailId.set(target.trailId, { ...target });
    }
  }
  return [...byTrailId.values()].sort((left, right) =>
    left.trailId.localeCompare(right.trailId),
  );
}

async function removeLedgerSegmentProjectionAtTargets(
  session: LedgerSession,
  segmentOrId: LedgerSegment | string,
  keepTrailId: string | undefined,
  additionalTargets: readonly LedgerTarget[],
  options: ProjectionTargetCleanupOptions,
): Promise<string[]> {
  requireCaptureContinuation(options.continueCapture);
  const document = ensureLedgerSegments(session, {
    continueCapture: options.continueCapture,
  });
  const segmentId = typeof segmentOrId === 'string' ? segmentOrId : segmentOrId.id;
  let segment = document.segments.find((item) => item.id === segmentId);
  if (!segment) return [];
  const movedFrom: string[] = [];
  const targets = mergeProjectionTargets(additionalTargets, segment.targets ?? []);

  for (const target of targets) {
    if (target.trailId === keepTrailId) continue;
    const maxAttempts = options.provenSourceIds
      ? 1
      : MAX_REPROJECTION_STABILIZATION_ATTEMPTS;
    let settled = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      requireCaptureContinuation(options.continueCapture);
      segment =
        currentSegment(session.id, segment.id, options.continueCapture) ?? segment;
      await options.onBeforeProjectionCleanup?.(segment.id, { ...target });
      const cleaned = removeSegmentAtTarget(session, segment, target, options);
      if (cleaned.removed > 0) movedFrom.push(cleaned.root);
      if (!cleaned.remaining || options.provenSourceIds) {
        settled = true;
        break;
      }
    }
    if (!settled) {
      throw new Error(
        `Ledger segment ${segment.id} kept changing while removing its projection; retry.`,
      );
    }
    segment =
      ensureLedgerSegments(session.id).segments.find((item) => item.id === segmentId) ??
      segment;
  }
  return [...new Set(movedFrom)];
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
  return removeLedgerSegmentProjectionAtTargets(
    session,
    segmentOrId,
    keepTrailId,
    [],
    options,
  );
}

/** Public command vocabulary alias. */
export const removeLedgerRangeProjection = removeLedgerSegmentProjection;

export interface LedgerSegmentReprojectionOptions
  extends MaterializeOptions, ProjectionRoutingOptions {
  /** Test/diagnostic hook called only after a phase is durably persisted. */
  onPhase?: (phase: LedgerSegmentMigration['phase']) => void | Promise<void>;
  /** Test/diagnostic seam around each proven source cleanup attempt. */
  onSourceCleanup?: (stage: 'before' | 'after', attempt: number) => void | Promise<void>;
  /** Explicit repair only: the source id is stale and canonical config owns this path. */
  allowStaleSamePathSource?: boolean;
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

function mergeSourceTargets(
  destinationTrailId: string,
  ...groups: ReadonlyArray<readonly LedgerTarget[]>
): LedgerTarget[] {
  return mergeProjectionTargets(...groups).filter(
    (target) => target.trailId !== destinationTrailId,
  );
}

function sameProjectionTargets(
  left: readonly LedgerTarget[],
  right: readonly LedgerTarget[],
): boolean {
  const canonicalLeft = mergeProjectionTargets(left);
  const canonicalRight = mergeProjectionTargets(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((target, index) => {
      const candidate = canonicalRight[index]!;
      return (
        target.trailId === candidate.trailId && samePath(target.path, candidate.path)
      );
    })
  );
}

function observedSourceTargets(
  segment: LedgerSegment,
  destinationTrailId: string,
): LedgerTarget[] {
  return (segment.targets ?? []).filter(
    (target) => target.trailId !== destinationTrailId,
  );
}

function migrationSourceTargets(
  migration: LedgerSegmentMigration | undefined,
  segment: LedgerSegment,
  destinationTrailId: string,
  continuesMigration: boolean,
): LedgerTarget[] {
  return mergeSourceTargets(
    destinationTrailId,
    migration?.sourceTargets ?? [],
    !continuesMigration && migration ? [migration.destination] : [],
    observedSourceTargets(segment, destinationTrailId),
  );
}

function hasExactDestinationPlacement(
  segment: LedgerSegment,
  trailId: string,
  root: string,
): boolean {
  const targets = segment.targets ?? [];
  return (
    segment.status === 'placed' &&
    segment.dismissedAt === undefined &&
    targets.length === 1 &&
    targets[0]?.trailId === trailId &&
    samePath(targets[0].path, root)
  );
}

function hasKnownSourceProjection(
  session: LedgerSession,
  segment: LedgerSegment,
  targets: readonly LedgerTarget[],
): boolean {
  const sourceIds = sourceIdsForSegment(session, segment);
  if (sourceIds.size === 0) return false;
  return targets.some((target) => {
    const sourceRoot = projectionTargetRoot(target);
    if (!trailExistsAt(sourceRoot, target.trailId)) return false;
    const sourcePaths = pathsForRoot(sourceRoot);
    return authorSlugs(sourcePaths).some((slug) =>
      readJournal(authorPaths(sourcePaths, slug)).some(
        (entry) => entry.sourceId !== undefined && sourceIds.has(entry.sourceId),
      ),
    );
  });
}

function currentSegment(
  sessionId: string,
  segmentId: string,
  continueCapture?: () => boolean,
): LedgerSegment | undefined {
  return ensureLedgerSegments(sessionId, { continueCapture }).segments.find(
    (candidate) => candidate.id === segmentId,
  );
}

function requireContinuingMigration(
  segment: LedgerSegment,
  trailId: string,
  root: string,
): LedgerSegmentMigration {
  if (!sameDestination(segment.migration, trailId, root)) {
    throw new Error(
      `Ledger segment migration changed while reprojecting ${segment.id}; retry the current destination.`,
    );
  }
  return segment.migration!;
}

function incompleteMigration(
  migration: LedgerSegmentMigration,
  phase: LedgerSegmentMigration['phase'],
  sourceTargets: LedgerTarget[],
): LedgerSegmentMigration {
  return {
    phase,
    destination: { ...migration.destination },
    sourceTargets,
    startedAt: migration.startedAt,
    updatedAt: new Date().toISOString(),
  };
}

function effectiveSegmentSourceIds(
  session: LedgerSession,
  segment: LedgerSegment,
): string[] {
  const effectiveIds = new Set(
    effectiveLedgerRecords(readLedgerRecords(session.id)).map((record) => record.id),
  );
  return [
    ...new Set(
      readLedgerSegmentRecords(session.id, segment)
        .filter((record) => effectiveIds.has(record.id))
        .map((record) => ledgerRecordProjectionSourceId(session.id, record)),
    ),
  ].sort();
}

function sameSourceIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((sourceId, index) => sourceId === right[index])
  );
}

function addMaterializeResult(
  aggregate: MaterializeResult,
  next: MaterializeResult,
): void {
  aggregate.completed &&= next.completed;
  aggregate.projected += next.projected;
  aggregate.prompts += next.prompts;
  aggregate.replies += next.replies;
  aggregate.decisions += next.decisions;
  aggregate.plans += next.plans;
  aggregate.toolCalls += next.toolCalls;
  aggregate.recaps += next.recaps;
  aggregate.edits += next.edits;
  aggregate.conversationEvents += next.conversationEvents;
  aggregate.stubs += next.stubs;
  aggregate.sessionId = next.sessionId;
  if (next.lastPromptId) aggregate.lastPromptId = next.lastPromptId;
}

const MAX_REPROJECTION_STABILIZATION_ATTEMPTS = 4;

async function materializeLedgerSegmentUntilStable(
  session: LedgerSession,
  segmentId: string,
  author: AuthorPaths,
  options: MaterializeOptions,
): Promise<{
  materialized: MaterializeResult;
  segment: LedgerSegment;
  effectiveSourceIds: string[];
  handledSourceIds: string[];
}> {
  let aggregate: MaterializeResult | undefined;
  for (let attempt = 0; attempt < MAX_REPROJECTION_STABILIZATION_ATTEMPTS; attempt += 1) {
    const before = currentSegment(session.id, segmentId, options.continueCapture);
    if (!before) {
      throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
    }
    const beforeEffectiveSourceIds = effectiveSegmentSourceIds(session, before);
    const beforeHandledSourceIds = [...sourceIdsForSegment(session, before)].sort();
    const next = await materializeLedgerSegment(session, segmentId, author, options);
    if (aggregate) addMaterializeResult(aggregate, next);
    else aggregate = { ...next };
    if (!next.completed) {
      return {
        materialized: aggregate,
        segment: before,
        effectiveSourceIds: beforeEffectiveSourceIds,
        handledSourceIds: beforeHandledSourceIds,
      };
    }

    const after = currentSegment(session.id, segmentId, options.continueCapture);
    if (!after) {
      throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
    }
    if (
      sameSourceIds(
        beforeEffectiveSourceIds,
        effectiveSegmentSourceIds(session, after),
      ) &&
      sameSourceIds(
        beforeHandledSourceIds,
        [...sourceIdsForSegment(session, after)].sort(),
      )
    ) {
      return {
        materialized: aggregate,
        segment: after,
        effectiveSourceIds: beforeEffectiveSourceIds,
        handledSourceIds: beforeHandledSourceIds,
      };
    }
  }
  throw new Error(
    `Ledger segment ${segmentId} kept changing while materializing; retry after capture settles.`,
  );
}

function requireStableCompletedProjection(
  session: LedgerSession,
  segmentId: string,
  trailId: string,
  root: string,
  expectedEffectiveSourceIds: readonly string[],
  options: ProjectionRoutingOptions,
): void {
  const segment = currentSegment(session.id, segmentId, options.continueCapture);
  if (!segment) {
    throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
  }
  const migration = requireContinuingMigration(segment, trailId, root);
  if (migration.phase !== 'complete' || migration.completedAt === undefined) {
    throw new Error(
      `Ledger segment migration changed while completing ${segment.id}; retry the current destination.`,
    );
  }
  const sourceTargets = mergeSourceTargets(
    trailId,
    migration.sourceTargets,
    observedSourceTargets(segment, trailId),
  );
  if (
    !sameSourceIds(
      expectedEffectiveSourceIds,
      effectiveSegmentSourceIds(session, segment),
    ) ||
    !hasExactDestinationPlacement(segment, trailId, root) ||
    hasKnownSourceProjection(session, segment, sourceTargets)
  ) {
    const reopened = incompleteMigration(
      migration,
      'destination-materialized',
      sourceTargets,
    );
    setLedgerSegmentMigration(session.id, segment.id, reopened, options.continueCapture);
    throw new Error(
      `Ledger segment placement changed after completing ${segment.id}; retry the destination.`,
    );
  }
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
  const continuesMigration = sameDestination(migration, trailId, root);
  let observedSources = observedSourceTargets(segment, trailId);
  assertDistinctProjectionIdentities(
    mergeProjectionTargets(
      !continuesMigration && migration ? [migration.destination] : [],
      observedSources,
    ),
    trailId,
    root,
    options.allowStaleSamePathSource,
  );
  let sourceTargets = migrationSourceTargets(
    migration,
    segment,
    trailId,
    continuesMigration,
  );
  if (!continuesMigration) {
    const now = new Date().toISOString();
    migration = {
      phase: 'planned',
      destination: { trailId, path: root },
      sourceTargets: sourceTargets.map((target) => ({ ...target })),
      startedAt: now,
      updatedAt: now,
    };
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    await options.onPhase?.('planned');
  } else if (migration) {
    const terminalStateDrifted =
      (migration.phase === 'complete' ||
        migration.phase === 'obsolete-projections-removed') &&
      (!hasExactDestinationPlacement(segment, trailId, root) ||
        hasKnownSourceProjection(session, segment, sourceTargets) ||
        (migration.phase === 'complete' && migration.completedAt === undefined));
    if (terminalStateDrifted) {
      migration = incompleteMigration(migration, 'planned', sourceTargets);
      setLedgerSegmentMigration(
        session.id,
        segment.id,
        migration,
        options.continueCapture,
      );
      await options.onPhase?.('planned');
    } else if (!sameProjectionTargets(sourceTargets, migration.sourceTargets)) {
      migration = {
        ...migration,
        sourceTargets,
        updatedAt: new Date().toISOString(),
      };
      setLedgerSegmentMigration(
        session.id,
        segment.id,
        migration,
        options.continueCapture,
      );
    }
  }
  if (!migration) {
    throw new Error(`Unable to initialize ledger segment migration: ${segment.id}`);
  }

  segment = currentSegment(session.id, segment.id, options.continueCapture);
  if (!segment) {
    throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
  }
  migration = requireContinuingMigration(segment, trailId, root);
  const initialMaterialization = await materializeLedgerSegmentUntilStable(
    session,
    segment.id,
    author,
    options,
  );
  const materialized = initialMaterialization.materialized;
  if (!materialized.completed) {
    return { materialized, movedFrom: [], phase: migration.phase };
  }

  segment = initialMaterialization.segment;
  migration = requireContinuingMigration(segment, trailId, root);
  observedSources = observedSourceTargets(segment, trailId);
  sourceTargets = mergeSourceTargets(trailId, migration.sourceTargets, observedSources);
  assertDistinctProjectionIdentities(
    observedSources,
    trailId,
    root,
    options.allowStaleSamePathSource,
  );
  if (
    migration.phase === 'complete' &&
    migration.completedAt !== undefined &&
    hasExactDestinationPlacement(segment, trailId, root) &&
    !hasKnownSourceProjection(session, segment, sourceTargets)
  ) {
    if (!sameProjectionTargets(sourceTargets, migration.sourceTargets)) {
      const now = new Date().toISOString();
      migration = { ...migration, sourceTargets, updatedAt: now, completedAt: now };
      setLedgerSegmentMigration(
        session.id,
        segment.id,
        migration,
        options.continueCapture,
      );
    }
    return { materialized, movedFrom: [], phase: 'complete' };
  }
  if (
    migration.phase === 'obsolete-projections-removed' &&
    hasExactDestinationPlacement(segment, trailId, root) &&
    !hasKnownSourceProjection(session, segment, sourceTargets)
  ) {
    const now = new Date().toISOString();
    migration = {
      ...migration,
      sourceTargets,
      phase: 'complete',
      updatedAt: now,
      completedAt: now,
    };
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    await options.onPhase?.('complete');
    requireStableCompletedProjection(
      session,
      segment.id,
      trailId,
      root,
      initialMaterialization.effectiveSourceIds,
      options,
    );
    return { materialized, movedFrom: [], phase: 'complete' };
  }
  const phaseBeforeDestination = migration.phase;
  if (
    phaseBeforeDestination !== 'destination-materialized' ||
    !sameProjectionTargets(sourceTargets, migration.sourceTargets)
  ) {
    migration = incompleteMigration(migration, 'destination-materialized', sourceTargets);
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    if (phaseBeforeDestination !== 'destination-materialized') {
      await options.onPhase?.('destination-materialized');
    }
  }

  segment = currentSegment(session.id, segment.id, options.continueCapture);
  if (!segment) {
    throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
  }
  migration = requireContinuingMigration(segment, trailId, root);
  const postPhaseMaterialization = await materializeLedgerSegmentUntilStable(
    session,
    segment.id,
    author,
    options,
  );
  addMaterializeResult(materialized, postPhaseMaterialization.materialized);
  if (!postPhaseMaterialization.materialized.completed) {
    return { materialized, movedFrom: [], phase: migration.phase };
  }
  segment = postPhaseMaterialization.segment;
  migration = requireContinuingMigration(segment, trailId, root);
  observedSources = observedSourceTargets(segment, trailId);
  sourceTargets = mergeSourceTargets(trailId, migration.sourceTargets, observedSources);
  assertDistinctProjectionIdentities(
    observedSources,
    trailId,
    root,
    options.allowStaleSamePathSource,
  );
  if (
    migration.phase !== 'destination-materialized' ||
    !sameProjectionTargets(sourceTargets, migration.sourceTargets)
  ) {
    migration = incompleteMigration(migration, 'destination-materialized', sourceTargets);
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  }

  markLedgerSegmentPlaced(session.id, segment.id, trailId, root, {
    continueCapture: options.continueCapture,
    pathRebase: options.rebase,
  });
  segment = currentSegment(session.id, segment.id, options.continueCapture);
  if (!segment) {
    throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
  }
  migration = requireContinuingMigration(segment, trailId, root);
  observedSources = observedSourceTargets(segment, trailId);
  sourceTargets = mergeSourceTargets(trailId, migration.sourceTargets, observedSources);
  assertDistinctProjectionIdentities(
    observedSources,
    trailId,
    root,
    options.allowStaleSamePathSource,
  );
  if (
    migration.phase !== 'destination-materialized' ||
    !sameProjectionTargets(sourceTargets, migration.sourceTargets)
  ) {
    migration = incompleteMigration(migration, 'destination-materialized', sourceTargets);
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  }
  const movedFromRoots = new Set<string>();
  let cleanupProof = postPhaseMaterialization;
  let cleanupSettled = false;
  for (let attempt = 0; attempt < MAX_REPROJECTION_STABILIZATION_ATTEMPTS; attempt += 1) {
    await options.onSourceCleanup?.('before', attempt);
    segment = currentSegment(session.id, segment.id, options.continueCapture);
    if (!segment) {
      throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
    }
    migration = requireContinuingMigration(segment, trailId, root);
    observedSources = observedSourceTargets(segment, trailId);
    sourceTargets = mergeSourceTargets(trailId, migration.sourceTargets, observedSources);
    assertDistinctProjectionIdentities(
      observedSources,
      trailId,
      root,
      options.allowStaleSamePathSource,
    );
    if (
      migration.phase !== 'destination-materialized' ||
      !sameProjectionTargets(sourceTargets, migration.sourceTargets)
    ) {
      migration = incompleteMigration(
        migration,
        'destination-materialized',
        sourceTargets,
      );
      setLedgerSegmentMigration(
        session.id,
        segment.id,
        migration,
        options.continueCapture,
      );
    }

    const current = readLedgerSession(session.id) ?? session;
    const cleanedRoots = await removeLedgerSegmentProjectionAtTargets(
      current,
      segment.id,
      trailId,
      migration.sourceTargets,
      {
        ...options,
        destination: { trailId, path: root },
        provenSourceIds: new Set(cleanupProof.handledSourceIds),
      },
    );
    for (const cleanedRoot of cleanedRoots) movedFromRoots.add(cleanedRoot);
    await options.onSourceCleanup?.('after', attempt);

    segment = currentSegment(session.id, segment.id, options.continueCapture);
    if (!segment) {
      throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
    }
    migration = requireContinuingMigration(segment, trailId, root);
    const catchUpMaterialization = await materializeLedgerSegmentUntilStable(
      session,
      segment.id,
      author,
      options,
    );
    addMaterializeResult(materialized, catchUpMaterialization.materialized);
    if (!catchUpMaterialization.materialized.completed) {
      return {
        materialized,
        movedFrom: [...movedFromRoots],
        phase: migration.phase,
      };
    }

    segment = catchUpMaterialization.segment;
    migration = requireContinuingMigration(segment, trailId, root);
    observedSources = observedSourceTargets(segment, trailId);
    sourceTargets = mergeSourceTargets(trailId, migration.sourceTargets, observedSources);
    assertDistinctProjectionIdentities(
      observedSources,
      trailId,
      root,
      options.allowStaleSamePathSource,
    );
    if (
      migration.phase !== 'destination-materialized' ||
      !sameProjectionTargets(sourceTargets, migration.sourceTargets)
    ) {
      migration = incompleteMigration(
        migration,
        'destination-materialized',
        sourceTargets,
      );
      setLedgerSegmentMigration(
        session.id,
        segment.id,
        migration,
        options.continueCapture,
      );
    }

    const sourceMembershipChanged =
      !sameSourceIds(
        cleanupProof.effectiveSourceIds,
        catchUpMaterialization.effectiveSourceIds,
      ) ||
      !sameSourceIds(
        cleanupProof.handledSourceIds,
        catchUpMaterialization.handledSourceIds,
      );
    if (
      !sourceMembershipChanged &&
      hasExactDestinationPlacement(segment, trailId, root) &&
      !hasKnownSourceProjection(session, segment, sourceTargets)
    ) {
      cleanupSettled = true;
      break;
    }
    cleanupProof = catchUpMaterialization;
  }
  if (!cleanupSettled) {
    migration = incompleteMigration(migration, 'destination-materialized', sourceTargets);
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    throw new Error(
      `Ledger segment ${segment.id} kept changing while cleaning source projections; retry the destination.`,
    );
  }
  const movedFrom = [...movedFromRoots];
  migration = {
    ...migration,
    sourceTargets,
    phase: 'obsolete-projections-removed',
    updatedAt: new Date().toISOString(),
  };
  setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  await options.onPhase?.('obsolete-projections-removed');

  segment = currentSegment(session.id, segment.id, options.continueCapture);
  if (!segment) {
    throw new Error(`Ledger segment disappeared while reprojecting: ${segmentId}`);
  }
  migration = requireContinuingMigration(segment, trailId, root);
  sourceTargets = mergeSourceTargets(
    trailId,
    migration.sourceTargets,
    observedSourceTargets(segment, trailId),
  );
  if (
    !hasExactDestinationPlacement(segment, trailId, root) ||
    hasKnownSourceProjection(session, segment, sourceTargets)
  ) {
    migration = incompleteMigration(migration, 'destination-materialized', sourceTargets);
    setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
    throw new Error(
      `Ledger segment placement changed while finalizing ${segment.id}; retry the destination.`,
    );
  }

  migration = {
    ...migration,
    sourceTargets,
    phase: 'complete',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  setLedgerSegmentMigration(session.id, segment.id, migration, options.continueCapture);
  await options.onPhase?.('complete');
  requireStableCompletedProjection(
    session,
    segment.id,
    trailId,
    root,
    cleanupProof.effectiveSourceIds,
    options,
  );
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
        if (target.trailId === keepTrailId) continue;
        let current = segment;
        let settled = false;
        for (
          let attempt = 0;
          attempt < MAX_REPROJECTION_STABILIZATION_ATTEMPTS;
          attempt += 1
        ) {
          requireCaptureContinuation(options.continueCapture);
          current =
            currentSegment(session.id, segment.id, options.continueCapture) ?? current;
          const cleaned = removeSegmentAtTarget(session, current, target, options);
          if (cleaned.removed > 0) movedFrom.push(cleaned.root);
          if (!cleaned.remaining) {
            settled = true;
            break;
          }
        }
        if (!settled) {
          throw new Error(
            `Ledger segment ${segment.id} kept changing while removing its projection; retry.`,
          );
        }
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
    const cleanupIdentity = projectionTargetCleanupIdentity(target, oldRoot, options);
    const prepared: PreparedAuthorCleanup[] = [];
    const batchId = ledgerBatchId(session.id);
    if (cleanupIdentity === 'matching') {
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
    options.onBeforeLegacyProjectionCommit?.({ ...target });
    requireCaptureContinuation(options.continueCapture);
    const commitRoot = projectionTargetRoot(target);
    if (!samePath(commitRoot, oldRoot)) {
      throw new Error(
        `Projection target ${target.trailId} moved from ${oldRoot} to ${commitRoot} while cleaning; retry.`,
      );
    }
    const commitIdentity = projectionTargetCleanupIdentity(target, commitRoot, options);
    if (commitIdentity !== cleanupIdentity) {
      throw new Error(
        `Projection target ${target.trailId} changed while cleaning ${oldRoot}; retry.`,
      );
    }
    if (ensureLedgerSegments(session.id).segments.length > 0) {
      throw new Error(
        `Ledger session ${session.id} gained segmented records while cleaning; retry.`,
      );
    }
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
 * Clear obsolete placements. Segmented sessions always remove exact turn IDs and
 * retain the trail because a concurrent turn can appear after any prune check.
 * Empty/pre-segmentation sessions keep the guarded provisional-prune fallback.
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
