import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
import { readAllArtifacts } from './artifacts.ts';
import { ShowtailError } from './errors.ts';
import {
  noteKnownProject,
  PROJECT_IDENTITY_CATALOG_VERSION,
  readGlobalConfig,
  type ProjectEditReference,
  type ProjectIdentity,
} from './globalConfig.ts';
import {
  allLedgerSessions,
  effectiveLedgerRecords,
  effectiveLedgerPath,
  effectiveLedgerSegmentPath,
  readLedgerIndex,
  readPersistedLedgerSegments,
  readLedgerRecords,
  type LedgerRecord,
} from './ledger.ts';
import {
  existingPathKey,
  findRoot,
  isEligibleAnchor,
  isHomedirCatchAll,
  isPathUnder,
  pathsForRoot,
  readConfig,
  samePath,
} from './storage.ts';
import type { Config } from '../types.ts';

export const PROJECT_RESOLUTION_SCHEMA_VERSION = 1 as const;

export type ProjectResolutionState =
  | 'catalog'
  | 'selected'
  | 'confirmation-required'
  | 'ambiguous'
  | 'conflict'
  | 'not-found';

export type ProjectSelectionMode = 'authoritative' | 'corroborated';

export interface ProjectSelection {
  trailId: string;
  root: string;
  displayName: string;
  mode: ProjectSelectionMode;
  evidence: string[];
  crossWorkspace?: boolean;
}

export interface ProjectCandidate {
  trailId: string;
  root: string;
  displayName: string;
  /** Present only in verbose output. */
  aliases?: string[];
  /** Present only in verbose output. */
  paths?: string[];
  /** Present only in verbose output. */
  sources?: string[];
  /** Present only in verbose output. */
  editBacked?: boolean;
  /** A trail id is simultaneously live at more than one validated root. */
  conflict?: boolean;
}

export interface ProjectResolution {
  schemaVersion: typeof PROJECT_RESOLUTION_SCHEMA_VERSION;
  state: ProjectResolutionState;
  selector?: string;
  selection?: ProjectSelection;
  candidates?: ProjectCandidate[];
}

export interface ProjectCatalogEntry {
  trailId: string;
  root: string;
  displayName: string;
  liveRoots: string[];
  paths: string[];
  /** Validated project and folder names; excludes edit-entrypoint aliases. */
  identityAliases: string[];
  aliases: string[];
  sources: string[];
  editBacked: boolean;
  conflict: boolean;
}

export interface ProjectCatalog {
  schemaVersion: typeof PROJECT_RESOLUTION_SCHEMA_VERSION;
  projects: ProjectCatalogEntry[];
  warnings: string[];
}

type HintSource =
  | 'known-project'
  | 'path-history'
  | 'identity-catalog'
  | 'identity-history'
  | 'identity-conflict'
  | 'ledger-index'
  | 'ledger-attachment'
  | 'ledger-edit'
  | 'ledger-target'
  | 'cwd';

interface ProjectHint {
  path: string;
  trailId?: string;
  source: HintSource;
  editBacked: boolean;
}

interface LiveRoot {
  root: string;
  config: Config;
  sources: Set<string>;
  editBacked: boolean;
}

interface CollectedProjectEvidence {
  hints: ProjectHint[];
  persistedIdentities: Map<string, ProjectIdentity>;
  invalidPersistedTrailIds: Set<string>;
  editReferencesByTrail: Map<string, Map<string, ProjectEditReference>>;
  entrypointBasenamesByTrail: Map<string, Set<string>>;
  warnings: string[];
}

interface ProjectIdentityObservation {
  configuredName?: string;
  entrypointBasenames: string[];
  editReferences: ProjectEditReference[];
  conflictPaths: string[];
  editBacked: boolean;
  resetIdentity: boolean;
}

interface BuiltProjectCatalog {
  catalog: ProjectCatalog;
  observations: Map<string, ProjectIdentityObservation>;
}

function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = existingPathKey(path);
    if (!seen.has(key)) seen.set(key, resolve(path));
  }
  return [...seen.values()];
}

function stringValues(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
}

function validPersistedEditReferences(values: unknown): ProjectEditReference[] {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (reference): reference is ProjectEditReference =>
      !!reference &&
      typeof reference === 'object' &&
      typeof reference.ledgerId === 'string' &&
      !!reference.ledgerId &&
      typeof reference.nativeSessionId === 'string' &&
      !!reference.nativeSessionId &&
      typeof reference.recordId === 'string' &&
      !!reference.recordId &&
      typeof reference.segmentId === 'string' &&
      !!reference.segmentId &&
      typeof reference.path === 'string' &&
      validAbsoluteEvidencePath(reference.path) &&
      typeof reference.basename === 'string' &&
      reference.basename === basename(reference.path) &&
      safeEvidenceBasename(reference.basename) &&
      (reference.sha256 === undefined || validSha256(reference.sha256)),
  );
}

function sameEditReferenceEvidence(
  persisted: ProjectEditReference,
  observed: ProjectEditReference,
): boolean {
  return (
    persisted.ledgerId === observed.ledgerId &&
    persisted.nativeSessionId === observed.nativeSessionId &&
    persisted.recordId === observed.recordId &&
    persisted.segmentId === observed.segmentId &&
    existingPathKey(persisted.path) === existingPathKey(observed.path) &&
    persisted.basename === observed.basename &&
    (persisted.sha256 === undefined || persisted.sha256 === observed.sha256)
  );
}

function revalidatedPersistedEditReferences(
  identity: ProjectIdentity | undefined,
  observed: ReadonlyMap<string, ProjectEditReference>,
): ProjectEditReference[] {
  return validPersistedEditReferences(identity?.editReferences).flatMap((persisted) => {
    const current = observed.get(editReferenceKey(persisted));
    return current && sameEditReferenceEvidence(persisted, current) ? [current] : [];
  });
}

function persistedIdentityNameAliases(identity: ProjectIdentity | undefined): string[] {
  if (!identity) return [];
  return [
    ...(typeof identity.configuredName === 'string' ? [identity.configuredName] : []),
    ...stringValues(identity.previousConfiguredNames),
    ...(typeof identity.currentFolderBasename === 'string'
      ? [identity.currentFolderBasename]
      : []),
    ...stringValues(identity.previousFolderBasenames),
  ];
}

/** Whole-word normalization shared by matching and its regression tests. */
export function canonicalProjectTokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function containsCompleteName(selector: string[], name: string[]): boolean {
  if (name.length === 0) return false;
  const available = tokenCounts(selector);
  for (const [token, count] of tokenCounts(name)) {
    if ((available.get(token) ?? 0) < count) return false;
  }
  return true;
}

function sharedTokenCount(selector: string[], name: string[]): number {
  const available = tokenCounts(selector);
  let shared = 0;
  for (const [token, count] of tokenCounts(name)) {
    shared += Math.min(available.get(token) ?? 0, count);
  }
  return shared;
}

function liveRootForHint(path: string): string | null {
  if (!isEligibleAnchor(path)) return null;
  const root = findRoot(path);
  if (!root || !existsSync(pathsForRoot(root).config)) return null;
  return resolve(root);
}

function liveTrailForEditPath(path: string): { root: string; trailId: string } | null {
  const root = liveRootForHint(dirname(resolve(path)));
  if (!root || isHomedirCatchAll(root)) return null;
  try {
    const trailId = readConfig(pathsForRoot(root)).trailId?.trim();
    return trailId ? { root, trailId } : null;
  } catch {
    return null;
  }
}

const MAX_EVIDENCE_PATH_LENGTH = 4096;
const CODE_SHAPED_BASENAME_RE =
  /^(?:```|~~~|\*\*\*|@@|diff\s+--git\b|---\s|\+\+\+\s|(?:const|let|var|function|class|import|export)\s)/i;

function safeEvidenceBasename(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /^[+-]/.test(value) ||
    /[<>:"|?*]/.test(value) ||
    /(?:^|[\\/])--/.test(value) ||
    CODE_SHAPED_BASENAME_RE.test(value)
  ) {
    return false;
  }
  return value !== '.' && value !== '..';
}

function validAbsoluteEvidencePath(path: string): boolean {
  const withoutDrive = /^[a-z]:[\\/]/i.test(path) ? path.slice(2) : path;
  return (
    path.length > 0 &&
    path.length <= MAX_EVIDENCE_PATH_LENGTH &&
    path.trim() === path &&
    isAbsolute(path) &&
    !/[\u0000-\u001f\u007f]/u.test(path) &&
    !withoutDrive.includes(':') &&
    !/(?:^|[\\/])--/.test(path) &&
    safeEvidenceBasename(basename(path))
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function realFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function validEditEvidence(record: LedgerRecord, effectivePath: string): boolean {
  return (
    !!record.file &&
    validAbsoluteEvidencePath(record.file) &&
    validAbsoluteEvidencePath(effectivePath) &&
    (record.deleted === true || validSha256(record.sha256) || realFile(effectivePath))
  );
}

function targetContainsEditPath(targetRoot: string, editPath: string): boolean {
  return !isHomedirCatchAll(targetRoot) && isPathUnder(editPath, targetRoot);
}

function trailHasEditProvenance(root: string, config: Config): boolean {
  if (config.anchorKind === 'edit' || config.initialization?.evidence === 'edit') {
    return true;
  }
  try {
    return readAllArtifacts(pathsForRoot(root)).length > 0;
  } catch {
    return false;
  }
}

function editReferenceKey(reference: ProjectEditReference): string {
  return `${reference.ledgerId}\t${reference.segmentId ?? ''}\t${reference.recordId}`;
}

function collectHints(cwd: string | undefined): CollectedProjectEvidence {
  const hints: ProjectHint[] = [];
  const ledgerEditHints = new Set<string>();
  const editTrailCache = new Map<string, { root: string; trailId: string } | null>();
  const persistedIdentities = new Map<string, ProjectIdentity>();
  const invalidPersistedTrailIds = new Set<string>();
  const editReferencesByTrail = new Map<string, Map<string, ProjectEditReference>>();
  const entrypointBasenamesByTrail = new Map<string, Set<string>>();
  const warnings: string[] = [];
  const global = readGlobalConfig();
  const supersededTrailIds = new Set(Object.keys(global.trailSupersessions ?? {}));
  for (const project of Array.isArray(global.knownProjects) ? global.knownProjects : []) {
    if (
      !project ||
      typeof project !== 'object' ||
      typeof project.path !== 'string' ||
      !isAbsolute(project.path)
    ) {
      continue;
    }
    const trailId =
      typeof project.trailId === 'string' && project.trailId.trim()
        ? project.trailId
        : undefined;
    if (trailId && supersededTrailIds.has(trailId)) continue;
    hints.push({
      path: project.path,
      ...(trailId ? { trailId } : {}),
      source: 'known-project',
      editBacked: false,
    });
    for (const path of stringValues(project.previousPaths)) {
      if (!isAbsolute(path)) continue;
      hints.push({
        path,
        ...(trailId ? { trailId } : {}),
        source: 'path-history',
        editBacked: false,
      });
    }
  }

  if (global.projectCatalog?.version === PROJECT_IDENTITY_CATALOG_VERSION) {
    for (const [trailId, identity] of Object.entries(global.projectCatalog.byTrailId)) {
      if (supersededTrailIds.has(trailId)) continue;
      let invalidReason: string | undefined;
      if (
        !identity ||
        identity.trailId !== trailId ||
        typeof identity.currentPath !== 'string' ||
        !isAbsolute(identity.currentPath)
      ) {
        invalidReason = 'its stored key or current path is invalid';
      } else {
        const currentRoot = liveRootForHint(identity.currentPath);
        if (currentRoot) {
          try {
            const liveTrailId = readConfig(pathsForRoot(currentRoot)).trailId?.trim();
            if (liveTrailId !== trailId) {
              invalidReason = `its current path now contains ${liveTrailId || 'no trail id'}`;
            }
          } catch {
            invalidReason = 'its current path has an unreadable live config';
          }
        }
      }
      if (invalidReason) {
        invalidPersistedTrailIds.add(trailId);
        warnings.push(`Ignored persisted identity ${trailId} because ${invalidReason}.`);
        continue;
      }

      persistedIdentities.set(trailId, identity);
      hints.push({
        path: identity.currentPath,
        trailId,
        source: 'identity-catalog',
        editBacked: false,
      });
      for (const path of identity.previousPaths ?? []) {
        if (typeof path !== 'string' || !isAbsolute(path)) continue;
        hints.push({
          path,
          trailId,
          source: 'identity-history',
          editBacked: false,
        });
      }
      for (const path of identity.conflictPaths ?? []) {
        if (typeof path !== 'string' || !isAbsolute(path)) continue;
        hints.push({
          path,
          trailId,
          source: 'identity-conflict',
          editBacked: false,
        });
      }
    }
  }

  try {
    for (const [trailId, trail] of Object.entries(readLedgerIndex().trails)) {
      if (supersededTrailIds.has(trailId)) continue;
      if (!trail || typeof trail.path !== 'string' || !isAbsolute(trail.path)) continue;
      hints.push({
        path: trail.path,
        trailId,
        source: 'ledger-index',
        editBacked: false,
      });
    }
  } catch {
    // The live config validation below remains usable without the index.
  }

  try {
    for (const session of allLedgerSessions()) {
      const targetHints = new Map<
        string,
        { trailId: string; path: string; editBacked: boolean }
      >();
      for (const target of session.targets ?? []) {
        if (!target || typeof target.path !== 'string' || !isAbsolute(target.path)) {
          continue;
        }
        targetHints.set(`${target.trailId}\t${existingPathKey(target.path)}`, {
          trailId: target.trailId,
          path: target.path,
          editBacked: false,
        });
      }
      try {
        const records = effectiveLedgerRecords(readLedgerRecords(session.id));
        const document = readPersistedLedgerSegments(session.id);
        const segmentByRecord = new Map(
          (document?.segments ?? []).flatMap((segment) =>
            segment.recordIds.map((recordId) => [recordId, segment] as const),
          ),
        );
        for (const segment of document?.segments ?? []) {
          for (const attachment of segment.attachments ?? []) {
            if (!validAbsoluteEvidencePath(attachment.path)) continue;
            const effectivePath = effectiveLedgerSegmentPath(segment, attachment.path);
            if (!validAbsoluteEvidencePath(effectivePath)) continue;
            hints.push({
              path: attachment.kind === 'file' ? dirname(effectivePath) : effectivePath,
              source: 'ledger-attachment',
              editBacked: false,
            });
          }
        }
        for (const segment of document?.segments ?? []) {
          for (const target of segment.targets ?? []) {
            if (!target || typeof target.path !== 'string' || !isAbsolute(target.path)) {
              continue;
            }
            const key = `${target.trailId}\t${existingPathKey(target.path)}`;
            if (!targetHints.has(key)) {
              targetHints.set(key, {
                trailId: target.trailId,
                path: target.path,
                editBacked: false,
              });
            }
          }
        }
        const validateTargets = (
          targets: Iterable<{ trailId: string; path: string }>,
        ): Array<{ root: string; trailId: string }> =>
          [...targets].flatMap((target) => {
            if (!isAbsolute(target.path)) return [];
            const root = liveRootForHint(target.path);
            if (!root) return [];
            try {
              return readConfig(pathsForRoot(root)).trailId?.trim() === target.trailId
                ? [{ root, trailId: target.trailId }]
                : [];
            } catch {
              return [];
            }
          });
        const validatedSessionTargets = validateTargets(session.targets ?? []);
        const validatedTargetsBySegment = new Map(
          (document?.segments ?? []).map((segment) => [
            segment.id,
            validateTargets(segment.targets ?? []),
          ]),
        );
        const editedTrailIdsBySegment = new Map<string, Set<string>>();
        for (const record of records) {
          if (
            record.kind !== 'edit' ||
            !record.file ||
            !validAbsoluteEvidencePath(record.file)
          ) {
            continue;
          }
          const segment = segmentByRecord.get(record.id);
          if (document && !segment) continue;
          const effectivePath = segment
            ? effectiveLedgerSegmentPath(segment, record.file)
            : effectiveLedgerPath(session, record.file);
          if (!validEditEvidence(record, effectivePath)) continue;
          const liveEdit = (() => {
            const key = existingPathKey(dirname(effectivePath));
            if (!editTrailCache.has(key)) {
              editTrailCache.set(key, liveTrailForEditPath(effectivePath));
            }
            return editTrailCache.get(key) ?? null;
          })();
          const fallbackTargets = segment
            ? (validatedTargetsBySegment.get(segment.id) ?? [])
            : validatedSessionTargets;
          const edit =
            liveEdit ??
            fallbackTargets
              .filter((target) => targetContainsEditPath(target.root, effectivePath))
              .sort((a, b) => b.root.length - a.root.length)[0];
          if (!edit) continue;
          if (segment) {
            const segmentEdits =
              editedTrailIdsBySegment.get(segment.id) ?? new Set<string>();
            segmentEdits.add(edit.trailId);
            editedTrailIdsBySegment.set(segment.id, segmentEdits);
            const absolutePath = resolve(effectivePath);
            const reference: ProjectEditReference = {
              ledgerId: session.id,
              nativeSessionId: session.nativeSessionId,
              recordId: record.id,
              segmentId: segment.id,
              path: absolutePath,
              basename: basename(absolutePath),
              ...(validSha256(record.sha256) ? { sha256: record.sha256 } : {}),
            };
            const references =
              editReferencesByTrail.get(edit.trailId) ??
              new Map<string, ProjectEditReference>();
            references.set(editReferenceKey(reference), reference);
            editReferencesByTrail.set(edit.trailId, references);
            const entrypoints =
              entrypointBasenamesByTrail.get(edit.trailId) ?? new Set<string>();
            entrypoints.add(reference.basename);
            entrypointBasenamesByTrail.set(edit.trailId, entrypoints);
          }
          const editKey = `${edit.trailId}\t${existingPathKey(edit.root)}`;
          if (!ledgerEditHints.has(editKey)) {
            ledgerEditHints.add(editKey);
            hints.push({
              path: edit.root,
              trailId: edit.trailId,
              source: 'ledger-edit',
              editBacked: true,
            });
          }
        }
        for (const segment of document?.segments ?? []) {
          const segmentEdits =
            editedTrailIdsBySegment.get(segment.id) ?? new Set<string>();
          for (const target of segment.targets ?? []) {
            const key = `${target.trailId}\t${existingPathKey(target.path)}`;
            const current = targetHints.get(key);
            if (current) current.editBacked ||= segmentEdits.has(target.trailId);
            for (const rebase of segment.pathRebases ?? []) {
              const targetKey = existingPathKey(target.path);
              if (
                targetKey !== existingPathKey(rebase.fromRoot) &&
                targetKey !== existingPathKey(rebase.toRoot)
              ) {
                continue;
              }
              for (const path of [rebase.fromRoot, rebase.toRoot]) {
                hints.push({
                  path,
                  trailId: target.trailId,
                  source: 'path-history',
                  editBacked: segmentEdits.has(target.trailId),
                });
              }
            }
          }
        }
      } catch {
        // A damaged segment/record set remains a location hint, never edit evidence.
      }
      for (const target of targetHints.values()) {
        hints.push({
          path: target.path,
          trailId: target.trailId,
          source: 'ledger-target',
          editBacked: target.editBacked,
        });
      }
      for (const rebase of session.pathRebases ?? []) {
        for (const target of session.targets ?? []) {
          const targetKey = existingPathKey(target.path);
          if (
            targetKey !== existingPathKey(rebase.fromRoot) &&
            targetKey !== existingPathKey(rebase.toRoot)
          ) {
            continue;
          }
          for (const path of [rebase.fromRoot, rebase.toRoot]) {
            hints.push({
              path,
              trailId: target.trailId,
              source: 'path-history',
              editBacked: false,
            });
          }
        }
      }
    }
  } catch {
    // Catalog discovery is best-effort; no source may make the command unusable.
  }

  if (cwd) {
    hints.push({ path: resolve(cwd), source: 'cwd', editBacked: false });
  }
  return {
    hints,
    persistedIdentities,
    invalidPersistedTrailIds,
    editReferencesByTrail,
    entrypointBasenamesByTrail,
    warnings,
  };
}

function buildProjectCatalogState(
  options: { cwd?: string; includeHomeRoot?: string } = {},
): BuiltProjectCatalog {
  const collected = collectHints(options.cwd);
  const { hints } = collected;
  const warnings: string[] = [...collected.warnings];
  const rootsByTrail = new Map<string, Map<string, LiveRoot>>();
  const historicalPaths = new Map<string, Set<string>>();
  const historicalSources = new Map<string, Set<string>>();
  const historicalEditBacked = new Set<string>();

  const rememberHistoricalHint = (hint: ProjectHint): void => {
    if (!hint.trailId || !isAbsolute(hint.path)) return;
    const paths = historicalPaths.get(hint.trailId) ?? new Set<string>();
    paths.add(resolve(hint.path));
    historicalPaths.set(hint.trailId, paths);
    const sources = historicalSources.get(hint.trailId) ?? new Set<string>();
    sources.add(hint.source);
    historicalSources.set(hint.trailId, sources);
    if (hint.editBacked) historicalEditBacked.add(hint.trailId);
  };

  for (const hint of hints) {
    const root = liveRootForHint(hint.path);
    if (!root) {
      rememberHistoricalHint(hint);
      continue;
    }
    if (
      isHomedirCatchAll(root) &&
      (!options.includeHomeRoot || !samePath(root, options.includeHomeRoot))
    ) {
      continue;
    }
    let config: Config;
    try {
      config = readConfig(pathsForRoot(root));
    } catch {
      continue;
    }
    const trailId = config.trailId?.trim();
    if (!trailId) continue;
    const identityMatches = !hint.trailId || hint.trailId === trailId;
    if (!identityMatches) {
      warnings.push(
        `Ignored stale identity ${hint.trailId} at ${root}; the live trail is ${trailId}.`,
      );
    } else {
      rememberHistoricalHint(hint);
    }
    const byRoot = rootsByTrail.get(trailId) ?? new Map<string, LiveRoot>();
    const key = existingPathKey(root);
    const current = byRoot.get(key);
    if (current) {
      if (identityMatches) current.sources.add(hint.source);
      current.editBacked ||= identityMatches && hint.editBacked;
    } else {
      byRoot.set(key, {
        root,
        config,
        sources: new Set(
          identityMatches ? [hint.source, 'live-config'] : ['live-config'],
        ),
        editBacked:
          (identityMatches && hint.editBacked) || trailHasEditProvenance(root, config),
      });
    }
    rootsByTrail.set(trailId, byRoot);
  }

  const projects: ProjectCatalogEntry[] = [];
  const observations = new Map<string, ProjectIdentityObservation>();
  for (const [trailId, byRoot] of rootsByTrail) {
    const roots = [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
    const liveRoots = roots.map((item) => item.root);
    const paths = uniquePaths([...liveRoots, ...(historicalPaths.get(trailId) ?? [])]);
    const identity = collected.persistedIdentities.get(trailId);
    const observedReferenceMap =
      collected.editReferencesByTrail.get(trailId) ??
      new Map<string, ProjectEditReference>();
    const persistedEditReferences = revalidatedPersistedEditReferences(
      identity,
      observedReferenceMap,
    );
    const observedEditReferences = [...observedReferenceMap.values()];
    const observedEntrypointBasenames = [
      ...(collected.entrypointBasenamesByTrail.get(trailId) ?? []),
    ];
    const configuredNames = roots.flatMap((item) =>
      item.config.project?.trim() ? [item.config.project.trim()] : [],
    );
    const displayName =
      configuredNames[0] ??
      identity?.configuredName?.trim() ??
      (basename(liveRoots[0]!) || trailId);
    const identityAliases = Array.from(
      new Set(
        [
          displayName,
          ...configuredNames,
          ...persistedIdentityNameAliases(identity),
          ...paths.map((path) => basename(path)),
        ].filter((value) => canonicalProjectTokens(value).length > 0),
      ),
    );
    const aliases = Array.from(
      new Set(
        [
          ...identityAliases,
          ...persistedEditReferences.map((reference) => parse(reference.basename).name),
          ...observedEntrypointBasenames.map((value) => parse(value).name),
        ].filter((value) => canonicalProjectTokens(value).length > 0),
      ),
    );
    const sources = new Set(historicalSources.get(trailId) ?? []);
    for (const item of roots) for (const source of item.sources) sources.add(source);
    const editBacked =
      historicalEditBacked.has(trailId) ||
      roots.some((item) => item.editBacked) ||
      observedEditReferences.length > 0;
    if (editBacked) sources.add('edit-backed-provenance');
    if (persistedEditReferences.length > 0) sources.add('identity-edit-reference');
    if (observedEditReferences.length > 0) sources.add('ledger-edit-reference');
    projects.push({
      trailId,
      root: liveRoots[0]!,
      displayName,
      liveRoots,
      paths,
      identityAliases,
      aliases,
      sources: [...sources].sort(),
      editBacked,
      conflict: liveRoots.length > 1,
    });
    observations.set(trailId, {
      ...(configuredNames[0] ? { configuredName: configuredNames[0] } : {}),
      entrypointBasenames: observedEntrypointBasenames,
      editReferences: observedEditReferences,
      conflictPaths: liveRoots,
      editBacked,
      resetIdentity: collected.invalidPersistedTrailIds.has(trailId),
    });
  }

  projects.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) || a.trailId.localeCompare(b.trailId),
  );
  return {
    catalog: {
      schemaVersion: PROJECT_RESOLUTION_SCHEMA_VERSION,
      projects,
      warnings: Array.from(new Set(warnings)),
    },
    observations,
  };
}

/**
 * Build a bounded, read-only project catalog from Showtail-owned hints. HOME is
 * never a semantic candidate, and every returned root is revalidated against
 * its live `.showtail/config.json`.
 */
export function buildProjectCatalog(options: { cwd?: string } = {}): ProjectCatalog {
  return buildProjectCatalogState(options).catalog;
}

/**
 * Persist one already-selected live identity. Unlike catalog construction and
 * selector resolution, this is intentionally mutating and replaces stale
 * ledger-derived aliases with evidence revalidated during this refresh.
 */
export function refreshProjectIdentity(
  root: string,
  options: { expectedTrailId?: string } = {},
): ProjectCatalogEntry | null {
  const liveRoot = liveRootForHint(resolve(root));
  if (!liveRoot) return null;

  let config: Config;
  try {
    config = readConfig(pathsForRoot(liveRoot));
  } catch {
    return null;
  }
  const trailId = config.trailId?.trim();
  if (!trailId || (options.expectedTrailId && options.expectedTrailId !== trailId)) {
    return null;
  }

  const built = buildProjectCatalogState({ cwd: liveRoot, includeHomeRoot: liveRoot });
  const project = built.catalog.projects.find((item) => item.trailId === trailId);
  const observation = built.observations.get(trailId);
  if (
    !project ||
    !observation ||
    !project.liveRoots.some((candidateRoot) => samePath(candidateRoot, liveRoot))
  ) {
    return null;
  }

  // Revalidate after evidence collection so a replaced config cannot be
  // persisted under the identity selected at the start of the refresh.
  const confirmedRoot = liveRootForHint(liveRoot);
  if (!confirmedRoot || !samePath(confirmedRoot, liveRoot)) return null;
  let confirmedConfig: Config;
  try {
    confirmedConfig = readConfig(pathsForRoot(confirmedRoot));
    if (confirmedConfig.trailId?.trim() !== trailId) return null;
  } catch {
    return null;
  }

  const configuredName = confirmedConfig.project?.trim();
  noteKnownProject(liveRoot, trailId, {
    ...(configuredName ? { configuredName } : {}),
    entrypointBasenames: observation.entrypointBasenames,
    editReferences: observation.editReferences,
    conflictPaths: project.liveRoots,
    editBacked: observation.editBacked,
    replaceEditEvidence: true,
    ...(observation.resetIdentity ? { resetIdentity: true } : {}),
  });
  return project;
}

function candidate(
  project: ProjectCatalogEntry,
  root: string,
  verbose: boolean,
): ProjectCandidate {
  return {
    trailId: project.trailId,
    root,
    displayName: project.displayName,
    ...(verbose
      ? {
          aliases: project.aliases,
          paths: project.paths,
          sources: project.sources,
          editBacked: project.editBacked,
          conflict: project.conflict,
        }
      : {}),
  };
}

function candidatesFor(
  projects: ProjectCatalogEntry[],
  verbose: boolean,
): ProjectCandidate[] {
  return projects.flatMap((project) =>
    project.liveRoots.map((root) => candidate(project, root, verbose)),
  );
}

function selection(
  project: ProjectCatalogEntry,
  root: string,
  mode: ProjectSelectionMode,
  evidence: string[],
  cwd: string,
): ProjectSelection {
  const workspace = findRoot(cwd) ?? resolve(cwd);
  const crossWorkspace = !samePath(workspace, root);
  return {
    trailId: project.trailId,
    root,
    displayName: project.displayName,
    mode,
    evidence,
    ...(crossWorkspace ? { crossWorkspace: true } : {}),
  };
}

function looksLikePath(selector: string): boolean {
  return (
    isAbsolute(selector) ||
    selector.startsWith('.') ||
    selector.startsWith('~') ||
    selector.includes('/') ||
    selector.includes('\\') ||
    /^[a-z]:/i.test(selector)
  );
}

/** Resolve a trail id, live path, or complete canonical project-name match. */
export function resolveProjectSelector(
  rawSelector: string,
  options: { cwd?: string; verbose?: boolean } = {},
): ProjectResolution {
  const selector = rawSelector.trim();
  const cwd = resolve(options.cwd ?? process.cwd());
  const verbose = options.verbose === true;
  const catalog = buildProjectCatalog({ cwd });
  const base = {
    schemaVersion: PROJECT_RESOLUTION_SCHEMA_VERSION,
    selector,
  } as const;
  if (!selector) return { ...base, state: 'not-found' };

  const byTrail = catalog.projects.find((project) => project.trailId === selector);
  if (byTrail) {
    if (byTrail.conflict) {
      return {
        ...base,
        state: 'conflict',
        candidates: candidatesFor([byTrail], verbose),
      };
    }
    return {
      ...base,
      state: 'selected',
      selection: selection(
        byTrail,
        byTrail.root,
        'authoritative',
        ['explicit-trail-id', 'live-config'],
        cwd,
      ),
    };
  }

  const resolvedPath = resolve(cwd, selector);
  if (isEligibleAnchor(resolvedPath)) {
    const root = liveRootForHint(resolvedPath);
    if (root) {
      try {
        const trailId = readConfig(pathsForRoot(root)).trailId?.trim();
        const exactCatalog = buildProjectCatalogState({
          cwd: root,
          includeHomeRoot: root,
        }).catalog;
        const project = exactCatalog.projects.find((item) => item.trailId === trailId);
        if (project) {
          return {
            ...base,
            state: 'selected',
            selection: selection(
              project,
              root,
              'authoritative',
              [
                'explicit-path',
                'live-config',
                ...(project.conflict ? ['duplicate-trail-explicit-path'] : []),
              ],
              cwd,
            ),
          };
        }
      } catch {
        return { ...base, state: 'not-found' };
      }
    }
    return { ...base, state: 'not-found' };
  }
  if (looksLikePath(selector)) return { ...base, state: 'not-found' };

  const selectorTokens = canonicalProjectTokens(selector);
  const matched = catalog.projects.flatMap((project) => {
    const matchingAliases = project.identityAliases.filter((alias) => {
      const aliasTokens = canonicalProjectTokens(alias);
      return aliasTokens.length >= 2 && containsCompleteName(selectorTokens, aliasTokens);
    });
    return matchingAliases.length > 0 ? [{ project, matchingAliases }] : [];
  });
  if (matched.length === 0) {
    // Partial name overlap may rank picker choices, but it never establishes
    // intent. Keep the result confirmation-only even when there is one leader.
    const ranked = catalog.projects
      .map((project) => ({
        project,
        score: Math.max(
          0,
          ...project.aliases.map((alias) =>
            sharedTokenCount(selectorTokens, canonicalProjectTokens(alias)),
          ),
        ),
        identityScore: Math.max(
          0,
          ...project.identityAliases.map((alias) =>
            sharedTokenCount(selectorTokens, canonicalProjectTokens(alias)),
          ),
        ),
      }))
      .filter((item) => item.score > 0);
    if (ranked.length === 0) return { ...base, state: 'not-found' };
    const identityRanked = ranked.filter((item) => item.identityScore > 0);
    const ranking = identityRanked.length > 0 ? identityRanked : ranked;
    const scoreKey = identityRanked.length > 0 ? 'identityScore' : 'score';
    const bestScore = Math.max(...ranking.map((item) => item[scoreKey]));
    const leaders = ranking
      .filter((item) => item[scoreKey] === bestScore)
      .map((item) => item.project);
    return {
      ...base,
      state: leaders.length > 1 ? 'ambiguous' : 'confirmation-required',
      candidates: candidatesFor(leaders, verbose),
    };
  }
  if (matched.length > 1) {
    return {
      ...base,
      state: 'ambiguous',
      candidates: candidatesFor(
        matched.map((item) => item.project),
        verbose,
      ),
    };
  }

  const match = matched[0]!;
  if (match.project.conflict) {
    return {
      ...base,
      state: 'conflict',
      candidates: candidatesFor([match.project], verbose),
    };
  }
  const hasSpecificName = match.matchingAliases.some(
    (alias) => canonicalProjectTokens(alias).length >= 2,
  );
  if (!hasSpecificName || !match.project.editBacked) {
    return {
      ...base,
      state: 'confirmation-required',
      candidates: candidatesFor([match.project], verbose),
    };
  }
  return {
    ...base,
    state: 'selected',
    selection: selection(
      match.project,
      match.project.root,
      'corroborated',
      ['complete-name', 'edit-backed-provenance', 'live-config'],
      cwd,
    ),
  };
}

export function projectCatalogResolution(
  options: { cwd?: string; verbose?: boolean } = {},
): ProjectResolution {
  const catalog = buildProjectCatalog({ cwd: options.cwd });
  return {
    schemaVersion: PROJECT_RESOLUTION_SCHEMA_VERSION,
    state: 'catalog',
    candidates: candidatesFor(catalog.projects, options.verbose === true),
  };
}

function selectionError(resolution: ProjectResolution): ShowtailError {
  const selector = resolution.selector ?? '';
  if (resolution.state === 'conflict') {
    return new ShowtailError(
      `Project "${selector}" has one trail id live in multiple folders. Choose an exact folder path.`,
      2,
      { resolution },
      'DUPLICATE_TRAIL_ID',
      'choose-project-path',
    );
  }
  if (resolution.state === 'ambiguous' || resolution.state === 'confirmation-required') {
    return new ShowtailError(
      resolution.state === 'ambiguous'
        ? `Project "${selector}" matches multiple Showtail trails.`
        : `Project "${selector}" needs an explicit path or trail id confirmation.`,
      2,
      { resolution },
      'PROJECT_SELECTION_REQUIRED',
      'choose-project',
    );
  }
  return new ShowtailError(
    `No live Showtail project matches "${selector}".`,
    2,
    { resolution },
    'PROJECT_NOT_FOUND',
    'choose-project',
  );
}

export interface ProjectCommandTarget {
  root: string;
  selection?: ProjectSelection;
}

export interface ProjectCommandIdentityPin {
  root: string;
  selectedRoot: string;
  identityRoot: string;
  trailId?: string;
}

function liveTrailIdAt(root: string): string | undefined {
  try {
    return readConfig(pathsForRoot(root)).trailId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function projectIdentityChanged(
  pin: ProjectCommandIdentityPin,
  actualTrailId: string | undefined,
): ShowtailError {
  return new ShowtailError(
    `The selected project changed while Showtail was preparing the command: ${pin.root}`,
    2,
    {
      root: null,
      selectedRoot: pin.selectedRoot,
      actualRoot: pin.root,
      expectedRoot: pin.identityRoot,
      observedRoot: existingPathKey(pin.root),
      expectedTrailId: pin.trailId ?? null,
      actualTrailId: actualTrailId ?? null,
    },
    'PROJECT_IDENTITY_CHANGED',
    'resolve-project-again',
  );
}

/** Pin the selected physical root and live trail id before a project control runs. */
export function pinProjectCommandIdentity(
  root: string,
  selection?: ProjectSelection,
): ProjectCommandIdentityPin {
  const absolute = resolve(root);
  if (selection && !samePath(absolute, selection.root)) {
    throw projectIdentityChanged(
      {
        root: absolute,
        selectedRoot: resolve(selection.root),
        identityRoot: existingPathKey(selection.root),
        trailId: selection.trailId,
      },
      liveTrailIdAt(absolute),
    );
  }
  const actualTrailId = liveTrailIdAt(absolute);
  if (selection && actualTrailId !== selection.trailId) {
    throw projectIdentityChanged(
      {
        root: absolute,
        selectedRoot: resolve(selection.root),
        identityRoot: existingPathKey(absolute),
        trailId: selection.trailId,
      },
      actualTrailId,
    );
  }
  return {
    root: absolute,
    selectedRoot: resolve(selection?.root ?? absolute),
    identityRoot: existingPathKey(absolute),
    ...(actualTrailId ? { trailId: actualTrailId } : {}),
  };
}

/** Fail closed if the selected root was retargeted or its config identity changed. */
export function assertProjectCommandIdentity(pin: ProjectCommandIdentityPin): void {
  const actualTrailId = liveTrailIdAt(pin.root);
  if (
    !samePath(pin.root, pin.identityRoot) ||
    (pin.trailId !== undefined && actualTrailId !== pin.trailId)
  ) {
    throw projectIdentityChanged(pin, actualTrailId);
  }
}

/**
 * Resolve a command's `--project` without ever falling back to process cwd.
 * Report/status may opt into an existing untracked path so their established
 * explicit-path behavior (including report-time initialization) stays intact.
 */
export function resolveProjectCommandTarget(
  rawSelector: string,
  options: { cwd?: string; allowUntrackedPath?: boolean } = {},
): ProjectCommandTarget {
  const selector = rawSelector.trim();
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!selector) throw selectionError(resolveProjectSelector(selector, { cwd }));

  const directPath = resolve(cwd, selector);
  if (isEligibleAnchor(directPath) && options.allowUntrackedPath) {
    const resolution = resolveProjectSelector(selector, { cwd });
    return {
      root: resolution.selection?.root ?? directPath,
      ...(resolution.selection ? { selection: resolution.selection } : {}),
    };
  }
  if (looksLikePath(selector) && !isEligibleAnchor(directPath)) {
    throw new ShowtailError(
      `Folder does not exist: ${directPath}`,
      2,
      {
        requestedRoot: directPath,
        root: null,
        candidateRoot: null,
        candidates: [],
      },
      'PATH_NOT_FOUND',
      'choose-existing-path',
    );
  }

  const resolution = resolveProjectSelector(selector, { cwd });
  if (resolution.state !== 'selected' || !resolution.selection) {
    throw selectionError(resolution);
  }
  return { root: resolution.selection.root, selection: resolution.selection };
}
