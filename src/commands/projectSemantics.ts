import { resolve } from 'node:path';
import { readGlobalConfig } from '../core/globalConfig.ts';
import {
  allLedgerSessions,
  effectiveLedgerRecords,
  ensureLedgerSegments,
  ledgerRecordProjectionSourceId,
  ledgerSegmentProjectContexts,
  readLedgerIndex,
  readLedgerRecords,
  supersededLedgerRecordIds,
  unresolvedLedgerSupersessionIssues,
  type LedgerRecord,
} from '../core/ledger.ts';
import { buildProjectCatalog } from '../core/projectCatalog.ts';
import {
  existingPathKey,
  readConfig,
  samePath,
  type ShowtailPaths,
} from '../core/storage.ts';
import type { JournalEntry } from '../types.ts';

export type ProjectSemanticConflictCode =
  | 'RETIRED_TRAIL_ID'
  | 'SAME_PATH_TRAIL_ID_CONFLICT'
  | 'DUPLICATE_TRAIL_ID'
  | 'MISSING_LEDGER_PROJECTION'
  | 'DUPLICATE_LEDGER_PROJECTION'
  | 'OBSOLETE_LEDGER_PROJECTION'
  | 'UNDECLARED_LEDGER_PROJECTION'
  | 'ROUTING_EVIDENCE_CONFLICT'
  | 'COLLAPSED_NATIVE_REQUEST_IDS'
  | 'INVALID_LEDGER_CORRECTION';

/** A stable, machine-readable semantic problem surfaced by status and verify. */
export interface ProjectSemanticConflict {
  code: ProjectSemanticConflictCode;
  message: string;
  trailIds?: string[];
  paths?: string[];
  sessionId?: string;
  segmentId?: string;
  sourceIds?: string[];
  count?: number;
}

interface IdentityClaim {
  trailId: string;
  path: string;
  source: string;
}

function addIdentityClaim(
  claims: IdentityClaim[],
  trailId: unknown,
  path: unknown,
  source: string,
): void {
  if (typeof trailId !== 'string' || !trailId.trim()) return;
  if (typeof path !== 'string' || !path.trim()) return;
  claims.push({ trailId: trailId.trim(), path: resolve(path), source });
}

function uniqueResolvedPaths(paths: Iterable<string>): string[] {
  return [
    ...new Map(
      [...paths].map((path) => [existingPathKey(path), resolve(path)] as const),
    ).values(),
  ];
}

/**
 * Find durable identity records that could route two trail IDs into one folder,
 * or one trail ID into multiple live folders. This deliberately examines only
 * current-path claims; historical paths are evidence of a move, not a conflict.
 */
export function projectIdentityConflicts(
  paths: ShowtailPaths,
): ProjectSemanticConflict[] {
  const trailId = readConfig(paths).trailId?.trim();
  if (!trailId) return [];

  const claims: IdentityClaim[] = [];
  addIdentityClaim(claims, trailId, paths.root, 'live-config');
  const global = readGlobalConfig();
  const conflicts: ProjectSemanticConflict[] = [];
  const supersession = global.trailSupersessions?.[trailId];
  if (supersession) {
    conflicts.push({
      code: 'RETIRED_TRAIL_ID',
      message:
        `${paths.root} has a live config using retired trail ID ${trailId}. ` +
        `That identity was superseded by ${supersession.canonicalTrailId} at ` +
        `${supersession.canonicalPath} and must not be routed or indexed as ${trailId}.`,
      trailIds: [trailId, supersession.canonicalTrailId],
      paths: uniqueResolvedPaths([paths.root, supersession.canonicalPath]),
    });
  }
  const supersededTrailIds = new Set(Object.keys(global.trailSupersessions ?? {}));
  for (const project of global.knownProjects ?? []) {
    addIdentityClaim(claims, project.trailId, project.path, 'known-project');
  }
  if (global.projectCatalog?.version === 1) {
    for (const [catalogTrailId, identity] of Object.entries(
      global.projectCatalog.byTrailId,
    )) {
      addIdentityClaim(claims, catalogTrailId, identity.currentPath, 'identity-catalog');
    }
  }
  for (const [indexedTrailId, location] of Object.entries(readLedgerIndex().trails)) {
    addIdentityClaim(claims, indexedTrailId, location.path, 'ledger-index');
  }

  const rootKey = existingPathKey(paths.root);
  const claimsAtRoot = claims.filter(
    (claim) =>
      !supersededTrailIds.has(claim.trailId) && existingPathKey(claim.path) === rootKey,
  );
  const idsAtRoot = [...new Set(claimsAtRoot.map((claim) => claim.trailId))].sort();
  if (idsAtRoot.length > 1) {
    const sources = [...new Set(claimsAtRoot.map((claim) => claim.source))].sort();
    conflicts.push({
      code: 'SAME_PATH_TRAIL_ID_CONFLICT',
      message:
        `${paths.root} is claimed by multiple trail IDs (${idsAtRoot.join(', ')}) ` +
        `in ${sources.join(', ')} metadata. Automatic routing must stop until one ` +
        'identity is retired.',
      trailIds: idsAtRoot,
      paths: [paths.root],
    });
  }

  const catalogEntry = buildProjectCatalog({ cwd: paths.root }).projects.find(
    (project) => project.trailId === trailId,
  );
  const liveRoots = uniqueResolvedPaths(catalogEntry?.liveRoots ?? []);
  if (liveRoots.length > 1) {
    conflicts.push({
      code: 'DUPLICATE_TRAIL_ID',
      message:
        `${trailId} is live in multiple folders (${liveRoots.join(', ')}). ` +
        'Showtail cannot know which copy owns new work.',
      trailIds: [trailId],
      paths: liveRoots,
    });
  }
  return conflicts;
}

function materializedRecord(
  kind: LedgerRecord['kind'],
  captureToolCalls: boolean,
): boolean {
  // Conversation events are settings-filtered. Snapshot-only edits can also be
  // hash-deduped against an earlier artifact without writing a second source ID,
  // so artifact integrity remains the authority for edits rather than treating
  // every duplicate edit notification as a missing projection.
  if (kind === 'conversation_event' || kind === 'edit') return false;
  if (kind === 'tool_call') return captureToolCalls;
  return true;
}

/** Copilot source IDs bind a record to one native request even after relocation. */
function copilotNativeRequestId(sourceId: string | undefined): string | undefined {
  if (!sourceId) return undefined;
  let value = sourceId.startsWith('conversation:')
    ? sourceId.slice('conversation:'.length)
    : sourceId;
  const fragment = value.indexOf('#');
  if (fragment >= 0) value = value.slice(0, fragment);
  const parts = value.split(':');
  if (
    parts.length < 4 ||
    parts[0] !== 'copilot' ||
    !['user', 'asst', 'edit', 'plan'].includes(parts[1] ?? '')
  ) {
    return undefined;
  }
  return parts.at(-1) || undefined;
}

/**
 * Compare the global ledger's declared placements with the records actually
 * present in this trail. Stable source IDs make missing/extra projections an
 * exact comparison rather than a name or prompt-text heuristic.
 */
export function projectProjectionConflicts(
  paths: ShowtailPaths,
  entries: readonly JournalEntry[],
): ProjectSemanticConflict[] {
  const config = readConfig(paths);
  const trailId = config.trailId?.trim();
  if (!trailId) return [];
  const captureToolCalls = config.settings.captureToolCalls !== false;
  const actualSourceIdCounts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.sourceId) continue;
    actualSourceIdCounts.set(
      entry.sourceId,
      (actualSourceIdCounts.get(entry.sourceId) ?? 0) + 1,
    );
  }
  const actualSourceIds = new Set(actualSourceIdCounts.keys());
  const ledgerSourceOwners = new Map<
    string,
    { sessionId: string; segmentId: string; targetsCurrentTrail: boolean }
  >();
  const expectedLedgerSourceOwners = new Map<
    string,
    { sessionId: string; segmentId: string; targetsCurrentTrail: boolean }
  >();
  const obsoleteLedgerSourceOwners = new Map<
    string,
    { sessionId: string; segmentId: string }
  >();
  const conflicts: ProjectSemanticConflict[] = [];

  for (const session of allLedgerSessions()) {
    const document = ensureLedgerSegments(session, { persist: false });
    const routes = ledgerSegmentProjectContexts(session, document);
    const rawRecords = readLedgerRecords(session.id);
    const rawRecordsById = new Map(
      rawRecords.map((record) => [record.id, record] as const),
    );
    const supersededRecordIds = supersededLedgerRecordIds(rawRecords);
    const correctionIssues = unresolvedLedgerSupersessionIssues(rawRecords);
    const recordsById = new Map(
      effectiveLedgerRecords(rawRecords).map((record) => [record.id, record]),
    );
    for (const segment of document.segments) {
      const targetsCurrentTrail = (segment.targets ?? []).some(
        (target) => target.trailId === trailId,
      );
      const records = segment.recordIds.flatMap((recordId) => {
        const record = recordsById.get(recordId);
        return record ? [record] : [];
      });
      for (const recordId of segment.recordIds) {
        if (!supersededRecordIds.has(recordId)) continue;
        const record = rawRecordsById.get(recordId);
        if (!record) continue;
        obsoleteLedgerSourceOwners.set(
          ledgerRecordProjectionSourceId(session.id, record),
          { sessionId: session.id, segmentId: segment.id },
        );
      }
      for (const record of records) {
        const sourceId = ledgerRecordProjectionSourceId(session.id, record);
        const owner = {
          sessionId: session.id,
          segmentId: segment.id,
          targetsCurrentTrail,
        };
        ledgerSourceOwners.set(sourceId, owner);
        if (materializedRecord(record.kind, captureToolCalls)) {
          expectedLedgerSourceOwners.set(sourceId, owner);
        }
      }
      if (!targetsCurrentTrail) continue;

      const segmentRecordIds = new Set(segment.recordIds);
      const effectiveCorrectionIdentities = new Set(
        records.flatMap((record) =>
          record.sourceId ? [`${record.kind}\0${record.sourceId}`] : [],
        ),
      );
      const segmentCorrectionIssues = correctionIssues.filter(
        (issue) =>
          segmentRecordIds.has(issue.recordId) ||
          (issue.sourceId !== undefined &&
            effectiveCorrectionIdentities.has(`${issue.kind}\0${issue.sourceId}`)),
      );
      if (segmentCorrectionIssues.length > 0) {
        const reasons = [
          ...new Set(segmentCorrectionIssues.map((issue) => issue.reason)),
        ].sort();
        conflicts.push({
          code: 'INVALID_LEDGER_CORRECTION',
          message:
            `${session.id}:${segment.id} has ${segmentCorrectionIssues.length} ` +
            `unresolved append-only correction issue(s): ${reasons.join(', ')}.`,
          trailIds: [trailId],
          sessionId: session.id,
          segmentId: segment.id,
          sourceIds: [
            ...new Set(
              segmentCorrectionIssues.map(
                (issue) => rawRecordsById.get(issue.recordId)?.sourceId ?? issue.recordId,
              ),
            ),
          ].slice(0, 5),
          count: segmentCorrectionIssues.length,
        });
      }

      const route = routes.get(segment.id);
      if (route && route.state === 'tracked' && !samePath(route.root, paths.root)) {
        conflicts.push({
          code: 'ROUTING_EVIDENCE_CONFLICT',
          message:
            `${session.id}:${segment.id} is placed in ${paths.root}, but its ` +
            `current ${route.evidence} evidence resolves to ${route.root}.`,
          trailIds: [trailId],
          paths: [paths.root, route.root],
          sessionId: session.id,
          segmentId: segment.id,
        });
      }

      const nativeRequestIds = [
        ...new Set(
          records.flatMap((record) => {
            const requestId = copilotNativeRequestId(record.sourceId);
            return requestId ? [requestId] : [];
          }),
        ),
      ];
      if (nativeRequestIds.length > 1) {
        conflicts.push({
          code: 'COLLAPSED_NATIVE_REQUEST_IDS',
          message:
            `${session.id}:${segment.id} contains ${nativeRequestIds.length} native ` +
            'request IDs; separate prompts were collapsed into one routable turn.',
          trailIds: [trailId],
          sessionId: session.id,
          segmentId: segment.id,
          sourceIds: nativeRequestIds.slice(0, 5),
          count: nativeRequestIds.length,
        });
      }

      const expected = records.flatMap((record) => {
        if (!materializedRecord(record.kind, captureToolCalls)) return [];
        return [ledgerRecordProjectionSourceId(session.id, record)];
      });
      const missing = expected.filter((sourceId) => !actualSourceIds.has(sourceId));
      if (missing.length > 0) {
        conflicts.push({
          code: 'MISSING_LEDGER_PROJECTION',
          message:
            `${session.id}:${segment.id} is marked placed in ${trailId}, but ` +
            `${missing.length} of ${expected.length} expected ledger record(s) are ` +
            'missing from the trail journal.',
          trailIds: [trailId],
          sessionId: session.id,
          segmentId: segment.id,
          sourceIds: missing.slice(0, 5),
          count: missing.length,
        });
      }
    }
  }

  const duplicateBySegment = new Map<
    string,
    { sessionId: string; segmentId: string; sourceIds: string[]; count: number }
  >();
  for (const [sourceId, count] of actualSourceIdCounts) {
    if (count <= 1) continue;
    const owner = expectedLedgerSourceOwners.get(sourceId);
    if (!owner?.targetsCurrentTrail) continue;
    const key = `${owner.sessionId}\t${owner.segmentId}`;
    const current = duplicateBySegment.get(key) ?? {
      sessionId: owner.sessionId,
      segmentId: owner.segmentId,
      sourceIds: [],
      count: 0,
    };
    current.sourceIds.push(sourceId);
    current.count += count - 1;
    duplicateBySegment.set(key, current);
  }
  for (const item of duplicateBySegment.values()) {
    conflicts.push({
      code: 'DUPLICATE_LEDGER_PROJECTION',
      message:
        `${item.sessionId}:${item.segmentId} has ${item.count} duplicate journal ` +
        `projection entr${item.count === 1 ? 'y' : 'ies'} beyond the one expected ` +
        'for each ledger record.',
      trailIds: [trailId],
      sessionId: item.sessionId,
      segmentId: item.segmentId,
      sourceIds: item.sourceIds.slice(0, 5),
      count: item.count,
    });
  }

  const obsoleteBySegment = new Map<
    string,
    { sessionId: string; segmentId: string; sourceIds: string[]; count: number }
  >();
  for (const [sourceId, count] of actualSourceIdCounts) {
    const owner = obsoleteLedgerSourceOwners.get(sourceId);
    if (!owner) continue;
    const key = `${owner.sessionId}\t${owner.segmentId}`;
    const current = obsoleteBySegment.get(key) ?? {
      ...owner,
      sourceIds: [],
      count: 0,
    };
    current.sourceIds.push(sourceId);
    current.count += count;
    obsoleteBySegment.set(key, current);
  }
  for (const item of obsoleteBySegment.values()) {
    conflicts.push({
      code: 'OBSOLETE_LEDGER_PROJECTION',
      message:
        `${item.sessionId}:${item.segmentId} has ${item.count} journal projection ` +
        `entr${item.count === 1 ? 'y' : 'ies'} for ledger records superseded by ` +
        'a valid correction.',
      trailIds: [trailId],
      sessionId: item.sessionId,
      segmentId: item.segmentId,
      sourceIds: item.sourceIds.slice(0, 5),
      count: item.count,
    });
  }

  const undeclaredBySegment = new Map<
    string,
    { sessionId: string; segmentId: string; sourceIds: string[] }
  >();
  for (const sourceId of actualSourceIds) {
    const owner = ledgerSourceOwners.get(sourceId);
    if (!owner || owner.targetsCurrentTrail) continue;
    const key = `${owner.sessionId}\t${owner.segmentId}`;
    const current = undeclaredBySegment.get(key) ?? { ...owner, sourceIds: [] };
    current.sourceIds.push(sourceId);
    undeclaredBySegment.set(key, current);
  }
  for (const item of undeclaredBySegment.values()) {
    conflicts.push({
      code: 'UNDECLARED_LEDGER_PROJECTION',
      message:
        `${item.sessionId}:${item.segmentId} has ${item.sourceIds.length} record(s) ` +
        `in ${trailId}, but the ledger no longer declares that turn placed here.`,
      trailIds: [trailId],
      sessionId: item.sessionId,
      segmentId: item.segmentId,
      sourceIds: item.sourceIds.slice(0, 5),
      count: item.sourceIds.length,
    });
  }
  return conflicts;
}

export function projectSemanticConflicts(
  paths: ShowtailPaths,
  entries: readonly JournalEntry[],
): ProjectSemanticConflict[] {
  return [
    ...projectIdentityConflicts(paths),
    ...projectProjectionConflicts(paths, entries),
  ];
}
