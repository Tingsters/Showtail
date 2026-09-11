import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { existingPathKey, readJson, writeJson } from './storage.ts';

/**
 * Machine-wide Showtail state that lives *outside* any project: whether the
 * one-time `showtail setup` has run and whether automatic tracking is enabled.
 *
 * Deliberately stored under `~/.showtail-cli/`, NOT `~/.showtail`: the latter is
 * the per-project marker. Current routing ignores that marker in HOME, while the
 * distinct global name keeps machine state and project data separate across all
 * versions. `SHOWTAIL_HOME` overrides the location so tests can point it at a temp
 * dir (mirrors the `SHOWTAIL_ROOT_CEILING` pattern).
 */
export interface KnownProject {
  /** Stable trail identity. Older entries may predate trail ids. */
  trailId?: string;
  /** Most recently observed absolute root. */
  path: string;
  /** Earlier roots retained as bounded move/copy validation hints. */
  previousPaths?: string[];
  /** True once real edit provenance has been observed for this trail. */
  editBacked?: boolean;
  lastSeenAt: string;
}

export const PROJECT_IDENTITY_CATALOG_VERSION = 1 as const;

/** Exact machine-ledger evidence that ties an edited file to one project identity. */
export interface ProjectEditReference {
  ledgerId: string;
  nativeSessionId: string;
  recordId: string;
  segmentId?: string;
  path: string;
  basename: string;
  sha256?: string;
}

/** Durable machine-local identity metadata keyed by the stable trail id. */
export interface ProjectIdentity {
  trailId: string;
  currentPath: string;
  previousPaths?: string[];
  configuredName?: string;
  previousConfiguredNames?: string[];
  currentFolderBasename: string;
  previousFolderBasenames?: string[];
  entrypointBasenames?: string[];
  previousEntrypointBasenames?: string[];
  editReferences?: ProjectEditReference[];
  conflictPaths?: string[];
  editBacked?: boolean;
  lastSeenAt: string;
}

export interface ProjectIdentityCatalog {
  version: typeof PROJECT_IDENTITY_CATALOG_VERSION;
  byTrailId: Record<string, ProjectIdentity>;
}

export interface GlobalConfig {
  /** Schema version, for upgrade-on-read. */
  version: number;
  /**
   * When true, a hook firing in an untracked but eligible folder silently
   * creates the trail (see the auto-init path in the hook handler). Off until
   * `showtail setup` turns it on, so a user who never ran setup is never
   * surprised by folders appearing.
   */
  autoInit?: boolean;
  /** ISO-8601 timestamp `showtail setup` last completed, if it has. */
  setupCompletedAt?: string;
  /**
   * Tools the opportunistic auto-connect sweep has already handled (connected, or
   * found already-connected). Each is processed at most once so a newly-installed
   * tool wires itself up without a manual `setup` re-run, while a tool the user
   * later disconnects is never re-installed against their wishes. See
   * `core/autoConnectSweep.ts`.
   */
  autoConnectedTools?: string[];
  /**
   * Tools the user explicitly disconnected. The automatic sweep must neither
   * reconnect nor refresh these until an explicit connect/setup enables them.
   */
  autoConnectDisabledTools?: string[];
  /**
   * Tools whose installed integrations must not capture, even if stale hooks
   * remain in another project. Set by a machine-wide disconnect and cleared
   * only by an explicit reconnect that enables automatic capture.
   *
   * This is deliberately separate from {@link autoConnectDisabledTools}, which
   * controls background installation/refresh rather than runtime consent.
   */
  captureDisabledTools?: string[];
  /**
   * Folders the student has marked as scratch (`showtail ignore <path>`). Sessions
   * whose work lives under one never surface in `showtail inbox` — the override for
   * a folder that *is* a real project but the student treats as a sandbox. Absolute,
   * resolved paths.
   */
  scratchPaths?: string[];
  /**
   * Minimum activity for an otherwise-eligible inbox session to surface. A session
   * shows if it has at least this many edits OR prompts. Defaults to
   * {@link DEFAULT_INBOX_MIN_SIGNAL} when unset.
   */
  inboxMinSignal?: { edits: number; prompts: number };
  /**
   * Set-once watermark for "when Showtail started capturing here" (first `setup`,
   * or first auto-backfill if setup predates this feature). Never rewritten — unlike
   * {@link setupCompletedAt}, which every `setup` run overwrites. Auto-backfill of a
   * folderless chat whose newest message predates this is skipped (watch-forward:
   * don't resurrect pre-Showtail history). Purely go-forward.
   */
  captureSince?: string;
  /**
   * The Showtail version that last wired up tools (pre-seeded their capture hooks).
   * When the running binary is newer, the auto-connect path re-runs each tool's
   * `autoConnect` once to refresh its hooks to the current format — so a student who
   * never re-runs a Showtail command still gets hook updates on a binary upgrade.
   * The re-wire is an idempotent merge, so bumping this never duplicates hooks.
   */
  wiringVersion?: string;
  /**
   * Revision of the managed tool instructions last refreshed on this machine.
   * Unlike `wiringVersion`, this can advance without a package-version change.
   */
  managedInstructionRevision?: number;
  /**
   * Integration generation last applied to each auto-connected tool. Per-tool
   * state keeps a temporarily unavailable tool stale without repeatedly
   * refreshing tools that already received the same update.
   */
  toolIntegrationGenerations?: Record<string, string>;
  /**
   * Whether `showtail report` opens the generated report afterwards: `always`,
   * `never`, or `ask` (the default — the post-report open menu prompts once per
   * run). Set when the user picks "always"/"never" in that menu.
   */
  autoOpenReport?: 'always' | 'never' | 'ask';
  /** Transcript-history generation this installation has acknowledged. */
  historyGeneration?: number;
  /** One-time v1→v2 migration offer state. */
  migrationOffer?: {
    generation: number;
    status: 'pending' | 'running' | 'completed' | 'declined';
    detectedAt: string;
    decidedAt?: string;
    bulkRunId?: string;
  };
  /** Machine-local paths of trails Showtail has seen, for future bulk maintenance. */
  knownProjects?: KnownProject[];
  /** Versioned metadata-first project identities, keyed by stable trail id. */
  projectCatalog?: ProjectIdentityCatalog;
  /** Cached release metadata and the user's passive-check preference. */
  update?: {
    automaticChecks?: boolean;
    lastAttemptedAt?: string;
    lastCheckedAt?: string;
    latestVersion?: string;
    lastNotifiedVersion?: string;
    lastNotifiedAt?: string;
  };
}

/** Default signal floor for surfacing an inbox session (see {@link GlobalConfig.inboxMinSignal}). */
export const DEFAULT_INBOX_MIN_SIGNAL = { edits: 1, prompts: 2 };

/** The directory holding machine-wide Showtail config (not a project trail). */
export function showtailHome(): string {
  const override = process.env.SHOWTAIL_HOME;
  return override && override.length > 0 ? override : join(homedir(), '.showtail-cli');
}

/** Absolute path to the global config file. */
export function globalConfigPath(): string {
  return join(showtailHome(), 'config.json');
}

/** Authoritative per-tool capture-consent file, isolated from shared config RMWs. */
export function toolCaptureConsentPath(cliName: string): string {
  return join(
    showtailHome(),
    'capture-consent',
    `tool-${encodeURIComponent(cliName)}.json`,
  );
}

/** Whether this machine already had Showtail global state before the current run. */
export function globalConfigExists(): boolean {
  return existsSync(globalConfigPath());
}

/**
 * The machine-local durable ledger directory. Every session is recorded here
 * first — before (and independent of) any project root resolving — so work from
 * a folderless/global tool, a scratch IDE workspace, or a zero-edit planning
 * session is never dropped. A repo's `.showtail/` is a *projection* of the
 * sessions the ledger placed there. Lives under {@link showtailHome} (never
 * inside a repo), so it never participates in git and may hold machine-local
 * absolute paths; the materialize step re-relativizes before anything lands in a
 * trail. `SHOWTAIL_HOME` relocates it for hermetic tests.
 */
export function ledgerDir(): string {
  return join(showtailHome(), 'ledger');
}

/**
 * Read the global config, tolerating a missing or corrupt file by returning a
 * safe default. Must never throw: it is read from inside the bulletproof hook
 * path, where any exception would risk disrupting the student's session.
 */
export function readGlobalConfig(): GlobalConfig {
  const file = globalConfigPath();
  if (!existsSync(file)) return { version: 1 };
  try {
    return readJson<GlobalConfig>(file);
  } catch {
    return { version: 1 };
  }
}

/** Persist the global config (atomic write; creates `~/.showtail-cli/` as needed). */
export function writeGlobalConfig(config: GlobalConfig): void {
  writeJson(globalConfigPath(), config);
}

function uniqueKnownPaths(paths: string[], current: string): string[] {
  const currentKey = existingPathKey(current);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    const key = existingPathKey(resolved);
    if (key === currentKey || seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  return unique.slice(-16);
}

function uniqueResolvedPaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    const key = existingPathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  return unique.slice(-16);
}

function uniqueStrings(
  values: Iterable<string>,
  current: Iterable<string> = [],
): string[] {
  const excluded = new Set(current);
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
    .filter((value) => !excluded.has(value))
    .slice(-32);
}

function editReferenceKey(reference: ProjectEditReference): string {
  return `${reference.ledgerId}\t${reference.segmentId ?? ''}\t${reference.recordId}`;
}

function mergeEditReferences(
  current: readonly ProjectEditReference[],
  observed: readonly ProjectEditReference[],
): ProjectEditReference[] {
  const byId = new Map<string, ProjectEditReference>();
  for (const reference of [...current, ...observed]) {
    if (
      !reference ||
      typeof reference.ledgerId !== 'string' ||
      !reference.ledgerId.trim() ||
      typeof reference.nativeSessionId !== 'string' ||
      !reference.nativeSessionId.trim() ||
      typeof reference.recordId !== 'string' ||
      !reference.recordId.trim() ||
      typeof reference.path !== 'string' ||
      !reference.path.trim() ||
      !isAbsolute(reference.path) ||
      typeof reference.basename !== 'string' ||
      !reference.basename.trim()
    ) {
      continue;
    }
    const path = resolve(reference.path);
    byId.set(editReferenceKey(reference), {
      ...reference,
      path,
      basename: basename(path),
    });
  }
  return [...byId.values()].slice(-64);
}

function sameEditReferences(
  left: readonly ProjectEditReference[],
  right: readonly ProjectEditReference[],
): boolean {
  const normalized = (references: readonly ProjectEditReference[]) =>
    mergeEditReferences([], references)
      .map((reference) => JSON.stringify(reference))
      .sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

function identityObservationChanges(
  identity: ProjectIdentity | undefined,
  path: string,
  options: KnownProjectObservation,
): boolean {
  if (options.resetIdentity) return true;
  if (!identity || existingPathKey(identity.currentPath) !== existingPathKey(path)) {
    return true;
  }
  const configuredName = options.configuredName?.trim();
  if (configuredName && configuredName !== identity.configuredName) return true;
  if (options.replaceEditEvidence) {
    const observedEntrypoints = uniqueStrings(
      (options.entrypointBasenames ?? []).map((value) => basename(value)),
    );
    const observedReferences = mergeEditReferences([], options.editReferences ?? []);
    const editBacked = options.editBacked === true || observedReferences.length > 0;
    if (!sameStringSet(observedEntrypoints, identity.entrypointBasenames ?? [])) {
      return true;
    }
    if ((identity.previousEntrypointBasenames?.length ?? 0) > 0) return true;
    if (!sameEditReferences(observedReferences, identity.editReferences ?? []))
      return true;
    if (editBacked !== (identity.editBacked === true)) return true;
  }
  if (options.entrypointBasenames) {
    const observed = options.entrypointBasenames.map((value) => basename(value));
    if (!sameStringSet(observed, identity.entrypointBasenames ?? [])) return true;
  }
  if (options.editReferences) {
    const known = new Set((identity.editReferences ?? []).map(editReferenceKey));
    if (
      options.editReferences.some((reference) => !known.has(editReferenceKey(reference)))
    ) {
      return true;
    }
  }
  if (options.conflictPaths) {
    const observed = uniqueResolvedPaths(options.conflictPaths).map(existingPathKey);
    const current = (identity.conflictPaths ?? []).map(existingPathKey);
    if (!sameStringSet(observed, current)) return true;
  }
  return options.editBacked === true && identity.editBacked !== true;
}

export interface KnownProjectObservation {
  editBacked?: boolean;
  configuredName?: string;
  entrypointBasenames?: string[];
  editReferences?: ProjectEditReference[];
  conflictPaths?: string[];
  /** Replace only ledger-derived evidence, retaining path and name history. */
  replaceEditEvidence?: boolean;
  /** Replace metadata that was contradicted by a live trail-id validation. */
  resetIdentity?: boolean;
}

/**
 * Record a project location in machine-local state, keyed by stable trail id.
 * A real identity/path change bypasses the timestamp debounce and retains the
 * previous root as a bounded hint for move/copy validation.
 */
export function noteKnownProject(
  path: string,
  trailId?: string,
  options: KnownProjectObservation = {},
): void {
  try {
    const resolved = resolve(path);
    const cfg = readGlobalConfig();
    const now = new Date().toISOString();
    const projects = [...(cfg.knownProjects ?? [])];
    const supportedCatalog =
      cfg.projectCatalog?.version === PROJECT_IDENTITY_CATALOG_VERSION
        ? cfg.projectCatalog
        : undefined;
    const trailIndex = trailId
      ? projects.findIndex((project) => project.trailId === trailId)
      : -1;
    const pathIndex = projects.findIndex(
      (project) => existingPathKey(project.path) === existingPathKey(resolved),
    );
    const index = trailIndex >= 0 ? trailIndex : pathIndex;
    if (index >= 0) {
      const current = projects[index]!;
      const samePath = existingPathKey(current.path) === existingPathKey(resolved);
      const sameTrail = current.trailId === trailId;
      const addsEditProvenance = options.editBacked === true && !current.editBacked;
      const identityChanged = trailId
        ? identityObservationChanges(
            supportedCatalog?.byTrailId[trailId],
            resolved,
            options,
          )
        : false;
      if (samePath && sameTrail && !addsEditProvenance && !identityChanged) {
        const lastSeen = Date.parse(current.lastSeenAt);
        if (Number.isFinite(lastSeen) && Date.now() - lastSeen < 5 * 60_000) return;
      }

      const previousPaths = options.resetIdentity
        ? []
        : uniqueKnownPaths(
            [
              ...(current.previousPaths ?? []),
              ...(sameTrail && !samePath ? [current.path] : []),
            ],
            resolved,
          );
      const editBacked = options.replaceEditEvidence
        ? options.editBacked === true
        : (!options.resetIdentity && sameTrail && current.editBacked) ||
          options.editBacked === true;
      projects[index] = {
        ...(trailId ? { trailId } : {}),
        path: resolved,
        ...(previousPaths.length > 0 ? { previousPaths } : {}),
        ...(editBacked ? { editBacked: true } : {}),
        lastSeenAt: now,
      };
    } else {
      projects.push({
        ...(trailId ? { trailId } : {}),
        path: resolved,
        ...(options.editBacked ? { editBacked: true } : {}),
        lastSeenAt: now,
      });
    }
    let projectCatalog = cfg.projectCatalog;
    if (trailId && (!projectCatalog || supportedCatalog)) {
      const byTrailId = { ...(supportedCatalog?.byTrailId ?? {}) };
      for (const [knownTrailId, identity] of Object.entries(byTrailId)) {
        if (
          knownTrailId !== trailId &&
          existingPathKey(identity.currentPath) === existingPathKey(resolved)
        ) {
          delete byTrailId[knownTrailId];
        }
      }
      const current = options.resetIdentity ? undefined : byTrailId[trailId];
      const samePath =
        current && existingPathKey(current.currentPath) === existingPathKey(resolved);
      const currentFolderBasename = basename(resolved);
      const observedEntrypoints = uniqueStrings(
        (options.entrypointBasenames ?? []).map((value) => basename(value)),
      );
      const currentEntrypoints = current?.entrypointBasenames ?? [];
      const entrypointsChanged =
        observedEntrypoints.length > 0 &&
        JSON.stringify(observedEntrypoints) !== JSON.stringify(currentEntrypoints);
      const configuredName = options.configuredName?.trim() || current?.configuredName;
      const previousConfiguredNames = uniqueStrings(
        [
          ...(current?.previousConfiguredNames ?? []),
          ...(current?.configuredName &&
          configuredName &&
          current.configuredName !== configuredName
            ? [current.configuredName]
            : []),
        ],
        configuredName ? [configuredName] : [],
      );
      const previousFolderBasenames = uniqueStrings(
        [
          ...(current?.previousFolderBasenames ?? []),
          ...(current && !samePath ? [current.currentFolderBasename] : []),
        ],
        [currentFolderBasename],
      );
      const entrypointBasenames = options.replaceEditEvidence
        ? observedEntrypoints
        : observedEntrypoints.length > 0
          ? observedEntrypoints
          : currentEntrypoints;
      const previousEntrypointBasenames = options.replaceEditEvidence
        ? []
        : uniqueStrings(
            [
              ...(current?.previousEntrypointBasenames ?? []),
              ...(entrypointsChanged ? currentEntrypointBasenames(current) : []),
            ],
            entrypointBasenames,
          );
      const editReferences = mergeEditReferences(
        options.replaceEditEvidence ? [] : (current?.editReferences ?? []),
        options.editReferences ?? [],
      );
      const conflictPaths =
        options.conflictPaths === undefined
          ? current?.conflictPaths
          : uniqueResolvedPaths(options.conflictPaths);
      const previousPaths = current
        ? uniqueKnownPaths(
            [
              ...(current.previousPaths ?? []),
              ...(!samePath ? [current.currentPath] : []),
            ],
            resolved,
          )
        : [];
      byTrailId[trailId] = {
        trailId,
        currentPath: resolved,
        ...(previousPaths.length > 0 ? { previousPaths } : {}),
        ...(configuredName ? { configuredName } : {}),
        ...(previousConfiguredNames.length > 0 ? { previousConfiguredNames } : {}),
        currentFolderBasename,
        ...(previousFolderBasenames.length > 0 ? { previousFolderBasenames } : {}),
        ...(entrypointBasenames.length > 0 ? { entrypointBasenames } : {}),
        ...(previousEntrypointBasenames.length > 0
          ? { previousEntrypointBasenames }
          : {}),
        ...(editReferences.length > 0 ? { editReferences } : {}),
        ...(conflictPaths && conflictPaths.length > 1 ? { conflictPaths } : {}),
        ...((
          options.replaceEditEvidence
            ? options.editBacked === true || editReferences.length > 0
            : current?.editBacked || options.editBacked || editReferences.length > 0
        )
          ? { editBacked: true }
          : {}),
        lastSeenAt: now,
      };
      projectCatalog = {
        version: PROJECT_IDENTITY_CATALOG_VERSION,
        byTrailId,
      };
    }
    writeGlobalConfig({
      ...cfg,
      knownProjects: projects,
      ...(projectCatalog ? { projectCatalog } : {}),
    });
  } catch {
    // Registry maintenance must never disrupt capture or a project command.
  }
}

function currentEntrypointBasenames(identity: ProjectIdentity | undefined): string[] {
  return identity?.entrypointBasenames ?? [];
}

/** Detect an existing installation crossing into the current history generation. */
export function detectHistoryUpgrade(
  generation: number,
  now: string = new Date().toISOString(),
): GlobalConfig['migrationOffer'] {
  if (process.env.SHOWTAIL_DISABLE_FIRST_RUN || !globalConfigExists()) return undefined;
  const cfg = readGlobalConfig();
  if ((cfg.historyGeneration ?? 1) >= generation) return cfg.migrationOffer;
  const migrationOffer = {
    generation,
    status: 'pending' as const,
    detectedAt: now,
  };
  writeGlobalConfig({ ...cfg, historyGeneration: generation, migrationOffer });
  return migrationOffer;
}

/** Update the one-time history migration offer without disturbing other config. */
export function setMigrationOffer(
  migrationOffer: NonNullable<GlobalConfig['migrationOffer']>,
): void {
  const cfg = readGlobalConfig();
  writeGlobalConfig({
    ...cfg,
    historyGeneration: migrationOffer.generation,
    migrationOffer,
  });
}

/** Whether automatic tracking (silent auto-init on first AI use) is enabled. */
export function autoInitEnabled(): boolean {
  return readGlobalConfig().autoInit === true;
}

/** Persist a user's explicit request that the automatic sweep leave a tool alone. */
export function disableToolAutoConnect(tool: string): void {
  const cfg = readGlobalConfig();
  if (cfg.autoConnectDisabledTools?.includes(tool)) return;
  writeGlobalConfig({
    ...cfg,
    autoConnectDisabledTools: [...(cfg.autoConnectDisabledTools ?? []), tool],
  });
}

/** Clear a tool-level automatic-connect opt-out after an explicit reconnect. */
export function enableToolAutoConnect(tool: string): void {
  const cfg = readGlobalConfig();
  if (!cfg.autoConnectDisabledTools?.includes(tool)) return;
  writeGlobalConfig({
    ...cfg,
    autoConnectDisabledTools: cfg.autoConnectDisabledTools.filter(
      (candidate) => candidate !== tool,
    ),
  });
}

type ToolCaptureConsent = {
  version: 1;
  tool: string;
  capture: 'disabled' | 'enabled';
  /** Automatic transcript recovery may not cross this explicit resume boundary. */
  enabledAt?: string;
};

/** Read authoritative consent; a present but unreadable marker fails closed. */
function readToolCaptureConsent(
  cliName: string,
): { disabled: boolean; enabledAt?: string } | undefined {
  const file = toolCaptureConsentPath(cliName);
  if (!existsSync(file)) return undefined;
  try {
    const consent = readJson<ToolCaptureConsent>(file);
    if (
      consent.version === 1 &&
      consent.tool === cliName &&
      (consent.capture === 'disabled' || consent.capture === 'enabled')
    ) {
      if (consent.capture === 'disabled') return { disabled: true };
      // Accept an enabled marker written by the short-lived pre-watermark build;
      // the next explicit connect upgrades it with a timestamp.
      if (consent.enabledAt === undefined) return { disabled: false };
      if (Number.isFinite(Date.parse(consent.enabledAt))) {
        return { disabled: false, enabledAt: consent.enabledAt };
      }
    }
  } catch {
    // A damaged consent marker must never silently restore capture.
  }
  return { disabled: true };
}

function writeToolCaptureConsent(
  cliName: string,
  capture: ToolCaptureConsent['capture'],
  enabledAt?: string,
): void {
  writeJson(toolCaptureConsentPath(cliName), {
    version: 1,
    tool: cliName,
    capture,
    ...(capture === 'enabled' && enabledAt ? { enabledAt } : {}),
  } satisfies ToolCaptureConsent);
}

/** Best-effort compatibility mirror for versions that only read global config. */
function mirrorToolCaptureConsent(cliName: string, disabled: boolean): void {
  try {
    const cfg = readGlobalConfig();
    const current = Array.isArray(cfg.captureDisabledTools)
      ? cfg.captureDisabledTools
      : [];
    const next = disabled
      ? Array.from(new Set([...current, cliName]))
      : current.filter((candidate) => candidate !== cliName);
    if (
      next.length === current.length &&
      next.every((candidate, index) => candidate === current[index])
    ) {
      return;
    }
    writeGlobalConfig({ ...cfg, captureDisabledTools: next });
  } catch {
    // The isolated consent marker remains authoritative if this shared write loses.
  }
}

/** Whether machine-wide capture is explicitly disabled for a canonical CLI name. */
export function toolCaptureGloballyDisabled(cliName: string): boolean {
  const consent = readToolCaptureConsent(cliName);
  if (consent !== undefined) return consent.disabled;
  const legacy = readGlobalConfig().captureDisabledTools;
  return Array.isArray(legacy) && legacy.includes(cliName);
}

/** Explicit reconnect time used as the lower bound for automatic transcript recovery. */
export function toolCaptureEnabledAt(cliName: string): string | undefined {
  const consent = readToolCaptureConsent(cliName);
  return consent?.disabled === false ? consent.enabledAt : undefined;
}

/** Persist a machine-wide capture stop before mirroring it into shared config. */
export function disableToolCapture(cliName: string): void {
  writeToolCaptureConsent(cliName, 'disabled');
  mirrorToolCaptureConsent(cliName, true);
}

/** Persist explicit capture consent before clearing the legacy shared mirror. */
export function enableToolCapture(
  cliName: string,
  enabledAt: string = new Date().toISOString(),
): void {
  const current = readToolCaptureConsent(cliName);
  // Re-running an already-enabled connect is a refresh, not a new privacy
  // boundary. Preserve its original resume time; upgrade timestamp-less markers.
  const effectiveEnabledAt =
    current?.disabled === false && current.enabledAt ? current.enabledAt : enabledAt;
  writeToolCaptureConsent(cliName, 'enabled', effectiveEnabledAt);
  mirrorToolCaptureConsent(cliName, false);
}

// --- inbox triage config --------------------------------------------------

/** The signal floor for surfacing an inbox session (config value or the default). */
export function readInboxMinSignal(): { edits: number; prompts: number } {
  return readGlobalConfig().inboxMinSignal ?? DEFAULT_INBOX_MIN_SIGNAL;
}

/** The user-marked scratch folders (absolute, resolved), or an empty list. */
export function readScratchPaths(): string[] {
  return readGlobalConfig().scratchPaths ?? [];
}

/** Add a folder to the scratch list (resolved + de-duplicated). Returns the new list. */
export function addScratchPath(path: string): string[] {
  const resolved = resolve(path);
  const cfg = readGlobalConfig();
  const next = Array.from(new Set([...(cfg.scratchPaths ?? []), resolved]));
  writeGlobalConfig({ ...cfg, scratchPaths: next });
  return next;
}

/** Remove a folder from the scratch list (by resolved path). Returns the new list. */
export function removeScratchPath(path: string): string[] {
  const resolved = resolve(path);
  const cfg = readGlobalConfig();
  const next = (cfg.scratchPaths ?? []).filter((p) => p !== resolved);
  writeGlobalConfig({ ...cfg, scratchPaths: next });
  return next;
}

// --- report open preference -----------------------------------------------

/** How `showtail report` should open the report: the remembered choice, or `ask`. */
export function readAutoOpenReport(): 'always' | 'never' | 'ask' {
  return readGlobalConfig().autoOpenReport ?? 'ask';
}

/** Remember the report open choice (`always`/`never`) picked in the open menu. */
export function setAutoOpenReport(value: 'always' | 'never'): void {
  const cfg = readGlobalConfig();
  writeGlobalConfig({ ...cfg, autoOpenReport: value });
}

// --- watch-forward watermark ----------------------------------------------

/** The set-once capture watermark, if one has been recorded. */
export function readCaptureSince(): string | undefined {
  return readGlobalConfig().captureSince;
}

/**
 * Record the capture watermark once. No-op (keeps the first value) if already set —
 * so an update / `setup` re-run never moves it. Returns the effective watermark.
 */
export function ensureCaptureSince(now: string = new Date().toISOString()): string {
  const cfg = readGlobalConfig();
  if (cfg.captureSince) return cfg.captureSince;
  writeGlobalConfig({ ...cfg, captureSince: now });
  return now;
}

/**
 * Whether an auto-backfill of a folderless conversation should be skipped: true
 * when a watermark exists and the conversation's newest message predates it. A
 * conversation with no known timestamp is never treated as stale (captured, then
 * hidden by the signal filter if trivial).
 */
export function isStaleForAutoBackfill(newestTs: string | undefined): boolean {
  const since = readCaptureSince();
  if (!since || !newestTs) return false;
  return newestTs < since;
}
