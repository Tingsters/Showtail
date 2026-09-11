import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config } from '../types.ts';
import { establishIdentity } from '../core/authors.ts';
import { requireCaptureContinuation } from '../core/captureGuard.ts';
import { gitToplevel } from '../core/git.ts';
import {
  effectiveLedgerSegmentPath,
  ensureLedgerSegments,
  listActionableLedgerRanges,
  listLedgerSegmentViews,
  markPlaced,
  pendingLedgerRangesForRoot,
  readLedgerSegmentRecords,
  sessionTouchesPath,
  unplacedSessions,
  type LedgerRangeView,
  type LedgerSegment,
  type LedgerSegmentView,
  type LedgerSession,
} from '../core/ledger.ts';
import { emitJson } from '../core/output.ts';
import { makeId } from '../core/ids.ts';
import { ShowtailError } from '../core/errors.ts';
import { noteKnownProject } from '../core/globalConfig.ts';
import {
  applyRebase,
  matchLedgerSegmentToRoot,
  prepareCandidateIndex,
  type CandidateIndex,
  type MatchTier,
  type PathRebase,
} from '../core/relocate.ts';
import {
  CONFIG_VERSION,
  ensureTrailId,
  isHomedirCatchAll,
  isPathUnder,
  pathsForRoot,
  readConfig,
  resolveProjectContext,
  samePath,
  SHOWTAIL_DIR,
  writeConfig,
  writeState,
  type ShowtailPaths,
} from '../core/storage.ts';
import { pendingRangeSummary, type PendingRangeSummary } from './ranges.ts';

/**
 * Mark the whole trail as binary so git never normalizes line endings: the
 * object store is content-addressed, and an EOL rewrite (common on Windows)
 * would change bytes and break a file's own hash / the integrity check. This
 * also keeps the shared object store byte-identical across machines, which is
 * what makes a merge of two students' trails conflict-free.
 */
const GITATTRIBUTES = `# Showtail stores content-addressed objects; keep bytes byte-exact.
* -text
`;

/**
 * The negation that keeps journal segments committable. Journal files are named
 * `journal/<machine>/0001.log`, and a `*.log` line in the *project's* own
 * `.gitignore` — which the Node, Python and Java templates all ship — silently
 * excludes every one of them. The trail then commits with its config and object
 * store but **no journal**, so the educator receives a trail containing none of
 * the student's prompts, and `verify`'s git-history check has nothing to read.
 *
 * A deeper `.gitignore` overrides a shallower one, and re-inclusion works here
 * because only the files were excluded, never their parent directories.
 */
const JOURNAL_UNIGNORE = '!authors/**/journal/**/*.log';

/**
 * Ephemeral/regenerable and machine-local bits don't belong in version control.
 * Everything else under .showtail/ — including every author's folder and the
 * shared object store — IS committed, so teammates' trails merge through git.
 */
const GITIGNORE = `state.json
reports/
diag/

# Keep journal segments committable even when the project ignores *.log.
${JOURNAL_UNIGNORE}
`;

const STAGED_TRAIL_PREFIX = `${SHOWTAIL_DIR}.init-`;

/**
 * Make sure the trail's `.gitignore` carries {@link JOURNAL_UNIGNORE}.
 *
 * Written on create, but also repaired on every `ensure`: trails created before
 * this existed are the ones actually at risk, and their journals are silently
 * uncommitted right now. Appends rather than rewrites, so a line someone added
 * themselves survives.
 */
export function ensureJournalUnignored(paths: ShowtailPaths): void {
  const file = join(paths.base, '.gitignore');
  if (!existsSync(file)) {
    writeFileSync(file, GITIGNORE, 'utf8');
    return;
  }
  const current = readFileSync(file, 'utf8');
  if (current.includes(JOURNAL_UNIGNORE)) return;
  const sep = current.endsWith('\n') ? '' : '\n';
  writeFileSync(
    file,
    `${current}${sep}\n# Keep journal segments committable even when the project ignores *.log.\n${JOURNAL_UNIGNORE}\n`,
    'utf8',
  );
}

export interface InitOptions {
  project?: string;
  /** Project root; defaults to cwd. */
  cwd?: string;
  /** Emit machine-readable JSON instead of the human banner. */
  json?: boolean;
}

export interface EnsureInitOptions {
  project?: string;
  /** How this root was selected; persisted for diagnostics and safe rerouting. */
  anchorKind?: NonNullable<Config['anchorKind']>;
  /** Why the trail was created and which ledger session triggered it. */
  initialization?: NonNullable<Config['initialization']>;
  /** Automatic callers abort when their original capture-consent epoch changes. */
  continueCapture?: () => boolean;
}

/** Build an unpublished sibling trail used to make first creation transactional. */
function stagedPaths(paths: ShowtailPaths): ShowtailPaths {
  const base = join(
    paths.root,
    `${STAGED_TRAIL_PREFIX}${randomBytes(12).toString('hex')}`,
  );
  return {
    ...paths,
    base,
    config: join(base, 'config.json'),
    state: join(base, 'state.json'),
    authorsDir: join(base, 'authors'),
    objectsDir: join(base, 'objects'),
    plansDir: join(base, 'plans'),
    reportsDir: join(base, 'reports'),
  };
}

/** Remove only the exact private sibling created by {@link stagedPaths}. */
function removeStagedTrail(paths: ShowtailPaths): void {
  const root = resolve(paths.root);
  const base = resolve(paths.base);
  if (dirname(base) !== root || !basename(base).startsWith(STAGED_TRAIL_PREFIX)) {
    return;
  }
  rmSync(base, { recursive: true, force: true });
}

/**
 * Create the shared `.showtail/` folder structure and config at `root` if it
 * isn't there yet, and report whether it was just created. This is the
 * idempotent core shared by explicit `showtail track`, hidden `showtail ensure`,
 * and the hook auto-init path. It prints nothing and does NOT establish an author
 * identity — callers own any user-facing output and identity resolution. Per-
 * author folders are created on demand (by `ensureAuthor`), not here.
 *
 * Concurrency: two near-simultaneous first hooks for the same new project can
 * both pass the config check. `writeJson` is an atomic temp+rename so config is
 * never torn; and `state` is written only when still absent, so a racing hook
 * that already recorded the active author isn't reset.
 */
export async function ensureInitialized(
  root: string,
  options: EnsureInitOptions = {},
): Promise<{ created: boolean; paths: ShowtailPaths }> {
  requireCaptureContinuation(options.continueCapture);
  const paths = pathsForRoot(root);
  if (existsSync(paths.config)) {
    // Existing trail: upgrade it in place (mint trailId + bump version on a v3
    // trail). No-op once already at the current version.
    requireCaptureContinuation(options.continueCapture);
    ensureTrailId(paths, options.continueCapture);
    // Repair a trail whose journal a project-level `*.log` rule is silently
    // keeping out of git. Trails created before that negation existed are the
    // ones actually affected, and they only get fixed on a path like this one.
    requireCaptureContinuation(options.continueCapture);
    ensureJournalUnignored(paths);
    const config = readConfig(paths);
    // An explicit `track` makes an automatically-created fallback intentional.
    // Keep unknown/older metadata conservative: only a trail positively marked
    // automatic is promoted here.
    if (
      options.initialization?.mode === 'track' &&
      config.initialization?.mode === 'automatic'
    ) {
      config.anchorKind = 'explicit';
      config.initialization = {
        mode: 'track',
        evidence: 'explicit',
        ...(config.initialization.ledgerSessionId
          ? { ledgerSessionId: config.initialization.ledgerSessionId }
          : {}),
      };
      requireCaptureContinuation(options.continueCapture);
      writeConfig(paths, config);
    }
    requireCaptureContinuation(options.continueCapture);
    noteKnownProject(root, config.trailId);
    return { created: false, paths };
  }

  // Git availability controls commit capture. The on-disk `.git` entry identifies
  // whether this exact root is the repository boundary without comparing Git's
  // long path spelling to Windows' possible 8.3 spelling of the same directory.
  const top = await gitToplevel(root);
  requireCaptureContinuation(options.continueCapture);
  const git = top !== undefined;
  const detectedEvidence = existsSync(join(root, '.git')) ? 'git' : 'cwd';
  const initialization = options.initialization ?? {
    mode: 'ensure',
    evidence: detectedEvidence,
  };
  const anchorKind =
    options.anchorKind ??
    (initialization.evidence === 'trail' ? detectedEvidence : initialization.evidence);

  const config: Config = {
    version: CONFIG_VERSION,
    createdAt: new Date().toISOString(),
    anchor: resolve(root),
    anchorKind,
    initialization,
    // Stable id the global ledger links sessions to (survives the repo moving).
    trailId: makeId('trl'),
    settings: {
      git,
      captureAiOutput: true,
      captureCode: true,
      captureToolCalls: true,
      redact: { enabled: true, secrets: true, pii: true },
    },
  };
  if (options.project) config.project = options.project;

  // Build the complete trail out of sight, then publish it with one rename. An
  // interrupted automatic capture can therefore remove its private staging tree
  // without leaving a partial or valid-looking `.showtail/` behind.
  const staged = stagedPaths(paths);
  try {
    for (const dir of [
      staged.base,
      staged.authorsDir,
      staged.objectsDir,
      staged.reportsDir,
    ]) {
      requireCaptureContinuation(options.continueCapture);
      mkdirSync(dir, { recursive: true });
    }

    requireCaptureContinuation(options.continueCapture);
    writeConfig(staged, config);
    requireCaptureContinuation(options.continueCapture);
    writeState(staged, { currentSessionId: null, currentPromptId: null });
    requireCaptureContinuation(options.continueCapture);
    writeFileSync(join(staged.base, '.gitattributes'), GITATTRIBUTES, 'utf8');
    requireCaptureContinuation(options.continueCapture);
    writeFileSync(join(staged.base, '.gitignore'), GITIGNORE, 'utf8');
    requireCaptureContinuation(options.continueCapture);
    renameSync(staged.base, paths.base);
  } catch (error) {
    removeStagedTrail(staged);
    // A simultaneous initializer may have published the same trail first. Adopt
    // that complete result instead of treating the harmless race as a failure.
    if (existsSync(paths.config)) {
      requireCaptureContinuation(options.continueCapture);
      ensureTrailId(paths, options.continueCapture);
      requireCaptureContinuation(options.continueCapture);
      ensureJournalUnignored(paths);
      const existing = readConfig(paths);
      requireCaptureContinuation(options.continueCapture);
      noteKnownProject(root, existing.trailId);
      return { created: false, paths };
    }
    throw error;
  }

  // Publication is the commit point. Registry maintenance is best-effort and is
  // skipped if consent changed immediately after the atomic rename.
  if (!options.continueCapture || options.continueCapture()) {
    noteKnownProject(root, config.trailId);
  }

  return { created: true, paths };
}

/** What a backfill sweep placed, and what it found but declined to place. */
export interface BackfillResult {
  placed: number;
  /** Ledger ids successfully claimed into this project. */
  claimedSessions: string[];
  /** Exact command-level ranges claimed into this project. */
  claimedSegments: WorkRangeRef[];
  /**
   * Sessions whose work matched only on content *similarity* (Tier B). Reported so
   * the student can confirm with `showtail move`, never auto-attributed: in a
   * provenance tool a wrong placement is worse than a missed one.
   */
  candidates: Array<{ id: string; detail: string }>;
  /** Multi-root sessions that mention this root but remain safely in the inbox. */
  pendingAmbiguous: Array<{ id: string; candidates: string[] }>;
  /** Exact atomic ranges that span more than one project. */
  pendingAmbiguousRanges: PendingAmbiguousRange[];
  /** Sessions whose already-captured files were safely recovered after a move. */
  relocatedSessions: RelocatedSession[];
  /** Exact turns recovered after their files moved. */
  relocatedSegments: RelocatedSegment[];
  /** Moved-work matches that require an explicit student choice. */
  relocationCandidates: RelocationCandidate[];
  /** Exact turns whose move evidence requires an explicit student choice. */
  segmentRelocationCandidates: SegmentRelocationCandidate[];
}

/** Stable identity for one command-level turn range. */
export interface WorkRangeRef {
  /** Composite `session:segment` selector accepted by range-aware commands. */
  id: string;
  sessionId: string;
  /** The first segment id, retained separately for structured consumers. */
  rangeId: string;
  /** Every independently stored turn represented by this command-level range. */
  segmentIds: string[];
}

/** Read-only pending range summary used by report/status/editor integrations. */
export interface PendingWorkRange extends PendingRangeSummary {
  segmentIds: string[];
}

/** An atomic multi-project range that Showtail deliberately leaves unclaimed. */
export interface PendingAmbiguousRange extends WorkRangeRef {
  candidates: string[];
}

/** Public success shape shared by CLI report/track and the VS Code integration. */
export interface RelocatedSession {
  id: string;
  from: string;
  to: string;
  tier: MatchTier;
  detail: string;
}

/** Why a content-lineage match was not safe enough to apply automatically. */
export type RelocationReviewReason = 'similarity' | 'mixed' | 'unsafe-rebase';

/** Public review shape shared by CLI report/track and the VS Code integration. */
export interface RelocationCandidate extends RelocatedSession {
  reason: RelocationReviewReason;
}

/** Segment-precise relocation success for mixed native editor chats. */
export interface RelocatedSegment extends WorkRangeRef {
  from: string;
  to: string;
  tier: MatchTier;
  detail: string;
}

/** Segment-precise relocation match that is not safe to apply automatically. */
export interface SegmentRelocationCandidate extends RelocatedSegment {
  reason: RelocationReviewReason;
}

export interface ClaimPendingWorkOptions {
  /** `resolved` is deterministic; `explicit` also accepts raw path and lineage evidence. */
  mode?: 'resolved' | 'explicit';
  /** Limit a hook-time claim to the session that triggered initialization. */
  ledgerSessionId?: string;
  /** Preserve why a claim-created trail was initialized. */
  initialization?: EnsureInitOptions;
  /** Establish a non-interactive provisional author when the claim creates a trail. */
  provisionalAuthor?: boolean;
}

export interface PendingWorkPreview {
  sessions: ReturnType<typeof unplacedSessions>;
  /** Deterministic pending ranges that resolve to this root. */
  ranges: PendingWorkRange[];
  pendingAmbiguous: BackfillResult['pendingAmbiguous'];
  pendingAmbiguousRanges: PendingAmbiguousRange[];
  /** Safe moved-work matches; previewing never changes placement or creates a trail. */
  safeRelocations: RelocatedSession[];
  safeSegmentRelocations: RelocatedSegment[];
  relocationCandidates: RelocationCandidate[];
  segmentRelocationCandidates: SegmentRelocationCandidate[];
}

interface SafeSegmentRelocation {
  session: LedgerSession;
  range: LedgerRangeView;
  rebase: PathRebase;
  summary: RelocatedSegment;
  legacySummary?: RelocatedSession;
  wasPlaced: boolean;
}

interface RelocationDiscovery {
  safe: SafeSegmentRelocation[];
  candidates: SegmentRelocationCandidate[];
}

interface DirectWorkDiscovery {
  ranges: LedgerRangeView[];
  ambiguousRanges: LedgerRangeView[];
}

function rangeRef(range: LedgerRangeView): WorkRangeRef {
  return {
    id: range.selector,
    sessionId: range.session.id,
    rangeId: range.segment.id,
    segmentIds: [...range.memberSegmentIds],
  };
}

function pendingWorkRange(range: LedgerRangeView): PendingWorkRange {
  return {
    ...pendingRangeSummary(range),
    segmentIds: [...range.memberSegmentIds],
  };
}

function pendingAmbiguousRange(range: LedgerRangeView): PendingAmbiguousRange {
  return {
    ...rangeRef(range),
    candidates: range.route.state === 'ambiguous' ? [...range.route.candidates] : [],
  };
}

function singleSegmentRange(view: LedgerSegmentView): LedgerRangeView {
  return {
    ...view,
    memberSegmentIds: [view.segment.id],
    segments: [view.segment],
  };
}

function uniqueSessionsForRanges(
  ranges: LedgerRangeView[],
): PendingWorkPreview['sessions'] {
  const sessions = new Map<string, PendingWorkPreview['sessions'][number]>();
  for (const range of ranges) {
    const existing = sessions.get(range.session.id);
    if (existing) {
      if (range.targetMissing) existing.targetMissing = true;
      continue;
    }
    sessions.set(range.session.id, {
      ...range.session,
      ...(range.targetMissing ? { targetMissing: true } : {}),
    });
  }
  return [...sessions.values()];
}

function aggregateAmbiguousRanges(
  ranges: LedgerRangeView[],
): BackfillResult['pendingAmbiguous'] {
  const sessions = new Map<string, Set<string>>();
  for (const range of ranges) {
    if (range.route.state !== 'ambiguous') continue;
    const candidates = sessions.get(range.session.id) ?? new Set<string>();
    for (const candidate of range.route.candidates) candidates.add(candidate);
    sessions.set(range.session.id, candidates);
  }
  return [...sessions].map(([id, candidates]) => ({
    id,
    candidates: [...candidates],
  }));
}

function ambiguousRangeRelatesToRoot(range: LedgerRangeView, root: string): boolean {
  if (range.route.state !== 'ambiguous') return false;
  const exactMatch = range.route.candidates.some((candidate) =>
    samePath(candidate, root),
  );
  const enclosesEveryCandidate =
    !isHomedirCatchAll(root) &&
    range.route.candidates.every((candidate) => isPathUnder(candidate, root));
  return exactMatch || enclosesEveryCandidate;
}

/** Raw-path compatibility for explicit `track <subfolder>` without session bleed. */
function segmentTouchesPath(
  session: LedgerSession,
  segment: LedgerSegment,
  folder: string,
  segmentCount: number,
): boolean {
  const records = readLedgerSegmentRecords(session.id, segment);
  const editPaths = records.flatMap((record) =>
    record.kind === 'edit' && record.file
      ? [effectiveLedgerSegmentPath(segment, record.file)]
      : [],
  );
  // File edits are stronger than a host's session-scoped cwd/workspace. VS Code
  // can keep reporting the folder where the chat began after the student opens
  // another project, which must not pull the later edit back into the old report.
  if (editPaths.length > 0) {
    return editPaths.some((path) => isPathUnder(path, folder));
  }
  for (const record of records) {
    const contextPaths = [
      ...(record.context?.cwd ? [record.context.cwd] : []),
      ...(record.context?.workspacePaths ?? []),
    ];
    if (
      contextPaths.some((path) =>
        isPathUnder(effectiveLedgerSegmentPath(segment, path), folder),
      )
    ) {
      return true;
    }
  }
  // Preserve the legacy session-wide fallback only when it cannot leak a sibling
  // turn from the same native editor chat into this project.
  return segmentCount === 1 && sessionTouchesPath(session, folder);
}

function rangeTouchesPath(
  range: LedgerRangeView,
  folder: string,
  persist: boolean,
): boolean {
  const document = ensureLedgerSegments(range.session, { persist });
  return range.segments.some((segment) =>
    segmentTouchesPath(range.session, segment, folder, document.segments.length),
  );
}

/** Discover deterministic pending ranges and related atomic ambiguous work. */
function discoverDirectWork(
  root: string,
  options: {
    mode: 'resolved' | 'explicit';
    ledgerSessionId?: string;
    persist: boolean;
  },
): DirectWorkDiscovery {
  const target = resolve(root);
  const all = listActionableLedgerRanges({
    includeHidden: true,
    pendingOnly: true,
    ...(options.ledgerSessionId ? { sessionId: options.ledgerSessionId } : {}),
    persist: options.persist,
  }).filter((range) => range.prompts > 0 || range.edits > 0);
  const sessionRanges = listActionableLedgerRanges({
    includeHidden: true,
    ...(options.ledgerSessionId ? { sessionId: options.ledgerSessionId } : {}),
    persist: options.persist,
  });
  const resolved = pendingLedgerRangesForRoot(target, {
    includeHidden: true,
    persist: options.persist,
  }).filter(
    (range) =>
      (!options.ledgerSessionId || range.session.id === options.ledgerSessionId) &&
      (range.prompts > 0 || range.edits > 0),
  );
  const resolvedIds = new Set(resolved.map((range) => range.selector));
  const rootsBySession = new Map<string, string[]>();
  const ambiguousSessions = new Set<string>();
  for (const range of sessionRanges) {
    if (range.route.state === 'ambiguous') {
      ambiguousSessions.add(range.session.id);
      continue;
    }
    if (range.route.state !== 'tracked' && range.route.state !== 'candidate') {
      continue;
    }
    const routeRoot = range.route.root;
    const roots = rootsBySession.get(range.session.id) ?? [];
    if (!roots.some((root) => samePath(root, routeRoot))) {
      roots.push(routeRoot);
    }
    rootsBySession.set(range.session.id, roots);
  }
  const ranges = all.filter((range) => {
    if (range.route.state === 'ambiguous') return false;
    if (resolvedIds.has(range.selector)) return true;
    const document = ensureLedgerSegments(range.session, {
      persist: options.persist,
    });
    // Before segmentation existed, one prompt-only session was claimable from
    // its captured cwd. Preserve that behavior without applying the session cwd
    // to every turn of a mixed editor chat.
    if (
      document.segments.length === 1 &&
      rangeTouchesPath(range, target, options.persist)
    ) {
      return true;
    }
    if (options.mode === 'explicit' && rangeTouchesPath(range, target, options.persist)) {
      return true;
    }
    // A prompt-only prefix can safely travel with its sole project witness. If
    // the native chat later touches A and B, it stays pending for manual review.
    const roots = rootsBySession.get(range.session.id) ?? [];
    return (
      range.route.state === 'none' &&
      range.edits === 0 &&
      !ambiguousSessions.has(range.session.id) &&
      roots.length === 1 &&
      samePath(roots[0]!, target)
    );
  });
  const ambiguousRanges = all.filter(
    (range) =>
      range.route.state === 'ambiguous' && ambiguousRangeRelatesToRoot(range, target),
  );
  return { ranges, ambiguousRanges };
}

function segmentEditPaths(session: LedgerSession, segment: LedgerSegment): string[] {
  const paths: string[] = [];
  for (const record of readLedgerSegmentRecords(session.id, segment)) {
    if (record.kind !== 'edit' || !record.file) continue;
    const file = effectiveLedgerSegmentPath(segment, record.file);
    if (!paths.some((existing) => samePath(existing, file))) paths.push(file);
  }
  return paths;
}

type SegmentEditPresence = 'none' | 'all-present' | 'all-absent' | 'mixed';

function segmentEditPresence(paths: string[]): SegmentEditPresence {
  if (paths.length === 0) return 'none';
  const present = paths.reduce((count, file) => count + Number(existsSync(file)), 0);
  if (present === paths.length) return 'all-present';
  if (present === 0) return 'all-absent';
  return 'mixed';
}

function relocationFrom(
  paths: string[],
  sourceFrom: string | undefined,
  rebase: PathRebase | undefined,
): string {
  return sourceFrom ?? rebase?.fromRoot ?? dirname(paths[0]!);
}

/** A relocation rebase is safe only when it maps every edit inside the new root. */
function fullyContainedSegmentRebase(
  paths: string[],
  root: string,
  rebase: PathRebase | undefined,
): rebase is PathRebase {
  if (!rebase) return false;
  return paths.every((file) => {
    const mapped = applyRebase(rebase, file);
    return mapped !== undefined && isPathUnder(mapped, root);
  });
}

function legacyRelocatedSession(summary: RelocatedSegment): RelocatedSession {
  return {
    id: summary.sessionId,
    from: summary.from,
    to: summary.to,
    tier: summary.tier,
    detail: summary.detail,
  };
}

function legacyRelocationCandidate(
  candidate: SegmentRelocationCandidate,
): RelocationCandidate {
  return { ...legacyRelocatedSession(candidate), reason: candidate.reason };
}

/**
 * A pre-segmentation session often contains several prompt-only turns followed
 * by one edit-bearing turn. Treat that shape as one compatibility cohort only
 * when there is no second project-bearing turn to leak across project reports.
 */
function legacyCompatibleSegment(
  session: LedgerSession,
  segment: LedgerSegment,
  persist: boolean,
): boolean {
  const views = listLedgerSegmentViews({
    includeHidden: true,
    sessionId: session.id,
    persist,
  });
  if (views.some((view) => view.route.state === 'ambiguous')) return false;
  const editBearing = views.filter(
    (view) => segmentEditPaths(session, view.segment).length > 0,
  );
  if (editBearing.length !== 1 || editBearing[0]!.segment.id !== segment.id) {
    return false;
  }
  const roots: string[] = [];
  for (const view of views) {
    if (view.route.state !== 'tracked' && view.route.state !== 'candidate') continue;
    const routeRoot = view.route.root;
    if (!roots.some((root) => samePath(root, routeRoot))) {
      roots.push(routeRoot);
    }
  }
  return roots.length <= 1;
}

/** Prompt-only compatibility turns may move with their sole edit-bearing turn. */
function legacyRelocationCohort(
  view: LedgerSegmentView,
  persist: boolean,
): LedgerSegment[] | null {
  if (!legacyCompatibleSegment(view.session, view.segment, persist)) return null;
  const document = ensureLedgerSegments(view.session, { persist });
  const currentTargets = view.segment.targets ?? [];
  if (view.segment.status === 'placed') {
    if (currentTargets.length !== 1) return null;
    const trailId = currentTargets[0]!.trailId;
    if (
      !document.segments.every(
        (segment) =>
          segment.status === 'placed' &&
          (segment.targets?.length ?? 0) === 1 &&
          segment.targets![0]!.trailId === trailId,
      )
    ) {
      return null;
    }
  } else if (
    !document.segments.every(
      (segment) => segment.status === 'inbox' && (segment.targets?.length ?? 0) === 0,
    )
  ) {
    return null;
  }
  return document.segments;
}

function compatibleLegacyCandidate(
  candidate: SegmentRelocationCandidate,
  persist: boolean,
): RelocationCandidate | null {
  const view = listLedgerSegmentViews({
    includeHidden: true,
    sessionId: candidate.sessionId,
    persist,
  }).find((item) => item.segment.id === candidate.rangeId);
  if (!view || !legacyCompatibleSegment(view.session, view.segment, persist)) {
    return null;
  }
  return legacyRelocationCandidate(candidate);
}

/** Discover exact relocations and review-only near matches without mutating state. */
async function discoverRelocationWork(
  root: string,
  ledgerSessionId?: string,
  persist = false,
): Promise<RelocationDiscovery> {
  const target = resolve(root);
  const safe: SafeSegmentRelocation[] = [];
  const candidates: SegmentRelocationCandidate[] = [];
  let index: CandidateIndex | undefined;

  for (const view of listLedgerSegmentViews({
    includeHidden: true,
    ...(ledgerSessionId ? { sessionId: ledgerSessionId } : {}),
    persist,
  })) {
    const { session, segment } = view;
    // One turn that edits A+B must remain review-only; content from one side may
    // never be used to auto-attribute the whole atomic turn to that side.
    if (view.route.state === 'ambiguous') continue;
    const paths = segmentEditPaths(session, segment);
    const editPresence = segmentEditPresence(paths);
    if (editPresence === 'none' || editPresence === 'all-present') continue;

    const targets = segment.targets ?? [];
    let sourceFrom: string | undefined;
    let wasPlaced = false;
    if (segment.status === 'placed') {
      if (targets.length !== 1) continue;
      wasPlaced = true;
      sourceFrom = view.targetPaths[0] ?? targets[0]!.path;
      if (samePath(sourceFrom, target)) continue;
    } else {
      if (targets.length > 1) continue;
      if (view.route.state === 'tracked' || view.route.state === 'candidate') {
        sourceFrom = view.route.root;
        if (samePath(sourceFrom, target)) continue;
      }
    }

    index ??= prepareCandidateIndex(target);
    let match;
    try {
      match = await matchLedgerSegmentToRoot(session, segment, target, {}, index);
    } catch {
      continue;
    }
    if (!match) continue;

    const cohort = legacyRelocationCohort(view, persist);
    const range = cohort
      ? {
          ...singleSegmentRange(view),
          memberSegmentIds: cohort.map((segment) => segment.id),
          segments: cohort,
        }
      : singleSegmentRange(view);
    const summary: RelocatedSegment = {
      ...rangeRef(range),
      from: relocationFrom(paths, sourceFrom, match.rebase),
      to: target,
      tier: match.tier,
      detail: match.detail,
    };
    const legacyEligible = legacyCompatibleSegment(session, segment, persist);
    if (editPresence === 'mixed') {
      candidates.push({ ...summary, reason: 'mixed' });
    } else if (match.tier === 'B') {
      candidates.push({ ...summary, reason: 'similarity' });
    } else if (!fullyContainedSegmentRebase(paths, target, match.rebase)) {
      candidates.push({ ...summary, reason: 'unsafe-rebase' });
    } else {
      safe.push({
        session,
        range,
        rebase: match.rebase,
        summary,
        ...(cohort ? { legacySummary: legacyRelocatedSession(summary) } : {}),
        wasPlaced: cohort
          ? cohort.every((member) => member.status === 'placed')
          : wasPlaced,
      });
    }
  }

  return { safe, candidates };
}

/** Read-only preview of unambiguous, signal-bearing work resolved to `root`. */
export async function pendingWorkForRoot(
  root: string,
  ledgerSessionId?: string,
): Promise<PendingWorkPreview> {
  const direct = discoverDirectWork(root, {
    mode: 'resolved',
    ...(ledgerSessionId ? { ledgerSessionId } : {}),
    persist: false,
  });
  const relocation = await discoverRelocationWork(root, ledgerSessionId, false);
  return {
    sessions: uniqueSessionsForRanges(direct.ranges),
    ranges: direct.ranges.map(pendingWorkRange),
    pendingAmbiguous: aggregateAmbiguousRanges(direct.ambiguousRanges),
    pendingAmbiguousRanges: direct.ambiguousRanges.map(pendingAmbiguousRange),
    safeRelocations: relocation.safe.flatMap((item) =>
      item.legacySummary ? [item.legacySummary] : [],
    ),
    safeSegmentRelocations: relocation.safe.map((item) => item.summary),
    relocationCandidates: relocation.candidates.flatMap((item) => {
      const legacy = compatibleLegacyCandidate(item, false);
      return legacy ? [legacy] : [];
    }),
    segmentRelocationCandidates: relocation.candidates,
  };
}

/**
 * Pull every unplaced session whose captured work belongs under `root` into this
 * trail. This is what makes `showtail track <folder>` rescue work Showtail had
 * parked in the inbox before the folder was a project (e.g. book exercises).
 *
 * Two ways a session can belong here. First the recorded-path test, which is the
 * common case and the original behavior. Failing that — because the student moved
 * the files, or had the AI move them, so every recorded absolute path is now stale
 * — we fall back to content-lineage matching (see `relocate.ts`; never filenames).
 * Deterministic Tier-A evidence places the session; weaker Tier-B evidence is only
 * reported, so attribution never shifts on a guess.
 *
 * Target-missing sessions are considered too, not just `inbox` ones: a trail whose
 * folder moved leaves its sessions `placed` against a path that no longer exists,
 * and those are exactly the ones needing rescue.
 *
 * Best-effort per session; a failure leaves that session where it was. Identity is
 * already established by the caller, so `reattach` resolves the author without
 * prompting. `reattach` is dynamically imported to avoid an init↔reattach cycle.
 */
export async function claimPendingWork(
  root: string,
  options: ClaimPendingWorkOptions = {},
): Promise<BackfillResult> {
  const { placeLedgerRangeInProject, reattachLedgerRange } =
    await import('./reattach.ts');
  const result: BackfillResult = {
    placed: 0,
    claimedSessions: [],
    claimedSegments: [],
    candidates: [],
    pendingAmbiguous: [],
    pendingAmbiguousRanges: [],
    relocatedSessions: [],
    relocatedSegments: [],
    relocationCandidates: [],
    segmentRelocationCandidates: [],
  };
  const direct = discoverDirectWork(root, {
    mode: options.mode ?? 'explicit',
    ...(options.ledgerSessionId ? { ledgerSessionId: options.ledgerSessionId } : {}),
    persist: true,
  });
  result.pendingAmbiguous = aggregateAmbiguousRanges(direct.ambiguousRanges);
  result.pendingAmbiguousRanges = direct.ambiguousRanges.map(pendingAmbiguousRange);
  const affectedSessions = new Set<string>();
  const claimedSegmentKeys = new Set<string>();
  for (const range of direct.ranges) {
    try {
      await placeLedgerRangeInProject(range, root, undefined, {
        ...(options.initialization ? { initialization: options.initialization } : {}),
        ...(options.provisionalAuthor ? { provisionalAuthor: true } : {}),
      });
      affectedSessions.add(range.session.id);
      if (!result.claimedSessions.includes(range.session.id)) {
        result.claimedSessions.push(range.session.id);
      }
      result.claimedSegments.push(rangeRef(range));
      for (const segmentId of range.memberSegmentIds) {
        claimedSegmentKeys.add(`${range.session.id}:${segmentId}`);
      }
    } catch {
      /* best-effort — a failed range simply stays where it was */
    }
  }

  // Relocation is separate from an ordinary inbox claim: it is content-proven,
  // carries a total path rebase, and may lift an already-placed session out of a
  // still-live old trail. Re-discover each safe match immediately before moving
  // it so copies, partial moves, and target changes cannot race the preview.
  const relocation = await discoverRelocationWork(root, options.ledgerSessionId, true);
  result.segmentRelocationCandidates.push(...relocation.candidates);
  result.relocationCandidates.push(
    ...relocation.candidates.flatMap((item) => {
      const legacy = compatibleLegacyCandidate(item, true);
      return legacy ? [legacy] : [];
    }),
  );
  for (const proposed of relocation.safe) {
    const segmentKey = `${proposed.session.id}:${proposed.range.segment.id}`;
    if (claimedSegmentKeys.has(segmentKey)) continue;
    const revalidated = await discoverRelocationWork(root, proposed.session.id, true);
    const current = revalidated.safe.find(
      (item) => item.summary.id === proposed.summary.id,
    );
    if (!current) {
      for (const candidate of revalidated.candidates) {
        if (
          !result.segmentRelocationCandidates.some((item) => item.id === candidate.id)
        ) {
          result.segmentRelocationCandidates.push(candidate);
          const legacy = compatibleLegacyCandidate(candidate, true);
          if (legacy) result.relocationCandidates.push(legacy);
        }
      }
      continue;
    }
    try {
      await reattachLedgerRange(current.range, root, {
        rebase: current.rebase,
        ...(options.initialization ? { initialization: options.initialization } : {}),
        ...(options.provisionalAuthor ? { provisionalAuthor: true } : {}),
      });
      if (current.legacySummary) {
        const destination = pathsForRoot(root);
        const trailId = readConfig(destination).trailId;
        if (trailId) {
          // Segment placement is authoritative. This only refreshes the legacy
          // whole-session rebase cache when the range safely covered every turn.
          markPlaced(current.session.id, trailId, resolve(root), {
            pathRebase: current.rebase,
          });
        }
      }
      affectedSessions.add(current.session.id);
      claimedSegmentKeys.add(segmentKey);
      if (current.wasPlaced) {
        result.relocatedSegments.push(current.summary);
        if (current.legacySummary) {
          result.relocatedSessions.push(current.legacySummary);
        }
      } else {
        if (!result.claimedSessions.includes(current.session.id)) {
          result.claimedSessions.push(current.session.id);
        }
        result.claimedSegments.push(rangeRef(current.range));
      }
    } catch {
      /* best-effort — a failed turn relocation remains at its prior placement */
    }
  }
  result.placed = affectedSessions.size;
  result.candidates = result.relocationCandidates
    .filter((candidate) => candidate.reason === 'similarity')
    .map(({ id, detail }) => ({ id, detail }));
  return result;
}

/** Print what a backfill did, including near-misses the student can confirm. */
function reportBackfill(result: BackfillResult): void {
  if (result.claimedSegments.length > 0) {
    console.log(
      `Pulled ${result.claimedSegments.length} already-captured work range(s) here from your inbox.`,
    );
    console.log('');
  }
  if (result.relocatedSegments.length > 0) {
    console.log(
      `Recovered ${result.relocatedSegments.length} moved work range(s) into this project.`,
    );
    for (const item of result.relocatedSegments) {
      console.log(`  ${item.id}: ${item.from} -> ${item.to}`);
    }
    console.log('');
  }
  if (result.segmentRelocationCandidates.length > 0) {
    console.log(
      `${result.segmentRelocationCandidates.length} more work range(s) look moved, but`,
    );
    console.log('they need review, so they were left alone:');
    for (const c of result.segmentRelocationCandidates) {
      console.log(`  ${c.id} — ${c.detail} (${c.reason})`);
    }
    console.log('  Place one with: showtail move <id> --to .');
    console.log('');
  }
}

/**
 * Create the `.showtail/` folder structure and config, then establish the local
 * student's identity (so their work lands in `authors/<slug>/`). Safe to re-run:
 * it won't overwrite an existing config, and a teammate re-running it in a repo
 * that's already set up just bootstraps *their own* author folder.
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const root = resolve(options.cwd ?? process.cwd());
  if (resolveProjectContext({ cwd: root, explicitPath: true }).state === 'none') {
    throw new ShowtailError(
      `Folder does not exist: ${root}`,
      2,
      { root: null, candidates: [] },
      'PATH_NOT_FOUND',
      'choose-existing-path',
    );
  }
  const paths = pathsForRoot(root);

  const explicitInitialization: NonNullable<Config['initialization']> = {
    mode: 'track',
    evidence: 'explicit',
  };

  if (existsSync(paths.config)) {
    await ensureInitialized(root, {
      anchorKind: 'explicit',
      initialization: explicitInitialization,
    });
    // Repair a trail whose journal a project-level `*.log` rule is keeping out of
    // git. `showtail track .` is what `verify` tells people to run for this, so it
    // has to actually fix it — and this is the branch a re-run takes.
    ensureJournalUnignored(paths);
    // The one mutation a re-run performs: set/update the project name. (init is
    // intentionally the single project-config entry point — no separate command.)
    let projectUpdated: string | null = null;
    if (options.project) {
      const config = readConfig(paths);
      if (config.project !== options.project) {
        config.project = options.project;
        writeConfig(paths, config);
      }
      projectUpdated = options.project;
    }

    // A re-run still backfills. This matters for the student who MOVED an already
    // tracked project: `.showtail/` travelled with the folder, so `init`/`track`
    // takes this branch — and returning early here is exactly what used to leave
    // their orphaned sessions stranded in the ledger.
    if (options.json) {
      const cfg = readConfig(paths);
      const jsonAuthor = await establishIdentity(paths, {
        cwd: root,
        allowPrompt: false,
      });
      const back = jsonAuthor
        ? await claimPendingWork(root, { mode: 'explicit' })
        : {
            placed: 0,
            claimedSessions: [],
            claimedSegments: [] as BackfillResult['claimedSegments'],
            candidates: [] as BackfillResult['candidates'],
            pendingAmbiguous: [] as BackfillResult['pendingAmbiguous'],
            pendingAmbiguousRanges: [] as BackfillResult['pendingAmbiguousRanges'],
            relocatedSessions: [] as BackfillResult['relocatedSessions'],
            relocatedSegments: [] as BackfillResult['relocatedSegments'],
            relocationCandidates: [] as BackfillResult['relocationCandidates'],
            segmentRelocationCandidates:
              [] as BackfillResult['segmentRelocationCandidates'],
          };
      emitJson({
        created: false,
        root,
        anchorKind: cfg.anchorKind ?? null,
        project: cfg.project ?? null,
        backfilled: back.placed,
        claimedSessions: back.claimedSessions,
        claimedSegments: back.claimedSegments,
        candidates: back.candidates,
        pendingAmbiguous: back.pendingAmbiguous,
        pendingAmbiguousRanges: back.pendingAmbiguousRanges,
        relocatedSessions: back.relocatedSessions,
        relocatedSegments: back.relocatedSegments,
        relocationCandidates: back.relocationCandidates,
        segmentRelocationCandidates: back.segmentRelocationCandidates,
      });
      return;
    }
    console.log('Showtail is already set up here (.showtail/config.json exists).');
    if (projectUpdated) console.log(`Updated project name to "${projectUpdated}".`);
    // Still make sure *this* student has an author folder — a teammate who just
    // cloned the repo runs `init` to register themselves without re-creating it.
    const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });
    if (author) console.log(`You're tracked as ${author.slug}.`);
    if (author) reportBackfill(await claimPendingWork(root, { mode: 'explicit' }));
    console.log('Just start working with your AI tool — capture happens automatically.');
    return;
  }

  if (options.json) {
    await ensureInitialized(root, {
      project: options.project,
      anchorKind: 'explicit',
      initialization: explicitInitialization,
    });
    // Register the local student silently when possible (no prompt in JSON mode).
    const jsonAuthor = await establishIdentity(paths, { cwd: root, allowPrompt: false });
    const back = jsonAuthor
      ? await claimPendingWork(root, { mode: 'explicit' })
      : {
          placed: 0,
          claimedSessions: [],
          claimedSegments: [] as BackfillResult['claimedSegments'],
          candidates: [] as BackfillResult['candidates'],
          pendingAmbiguous: [] as BackfillResult['pendingAmbiguous'],
          pendingAmbiguousRanges: [] as BackfillResult['pendingAmbiguousRanges'],
          relocatedSessions: [] as BackfillResult['relocatedSessions'],
          relocatedSegments: [] as BackfillResult['relocatedSegments'],
          relocationCandidates: [] as BackfillResult['relocationCandidates'],
          segmentRelocationCandidates:
            [] as BackfillResult['segmentRelocationCandidates'],
        };
    emitJson({
      created: true,
      root,
      anchorKind: readConfig(paths).anchorKind ?? null,
      backfilled: back.placed,
      claimedSessions: back.claimedSessions,
      claimedSegments: back.claimedSegments,
      candidates: back.candidates,
      pendingAmbiguous: back.pendingAmbiguous,
      pendingAmbiguousRanges: back.pendingAmbiguousRanges,
      relocatedSessions: back.relocatedSessions,
      relocatedSegments: back.relocatedSegments,
      relocationCandidates: back.relocationCandidates,
      segmentRelocationCandidates: back.segmentRelocationCandidates,
    });
    return;
  }

  await ensureInitialized(root, {
    project: options.project,
    anchorKind: 'explicit',
    initialization: explicitInitialization,
  });
  const config = readConfig(paths);

  // Establish who is working here so their trail is attributed (gh → git → prompt).
  const author = await establishIdentity(paths, { cwd: root, allowPrompt: true });

  console.log('Created .showtail/ — your work trail lives here.');
  console.log('');
  console.log('  .showtail/');
  console.log('    config.json      project settings (shared)');
  console.log('    authors/         one folder per student: their sessions + journal');
  console.log(
    '    objects/         content (prompts, AI responses, diffs), deduped & shared',
  );
  console.log('    reports/         generated reports for your educator');
  console.log('');
  if (author) {
    console.log(
      `You're set up as ${author.slug}. Your teammates each get their own folder.`,
    );
  } else {
    console.log(
      'No git/gh identity yet — Showtail will still capture your work under a temporary',
    );
    console.log(
      'name and switch it to your real identity automatically once you set git user.email',
    );
    console.log('(which you do to commit/collaborate anyway).');
  }
  console.log('');
  if (config.settings.git) {
    console.log('Git detected: commit hashes will be captured automatically.');
  } else {
    console.log(
      'No git repo detected: Showtail will still work, just without commit hashes.',
    );
  }
  console.log('');
  if (author) reportBackfill(await claimPendingWork(root, { mode: 'explicit' }));
  console.log('Next: just start working with your AI tool — capture is automatic.');
}
