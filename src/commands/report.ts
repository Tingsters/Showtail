import { dirname, join, resolve } from 'node:path';
import {
  type AiMode,
  buildReportData,
  renderHtml,
  renderMarkdown,
  type ReportRenderOptions,
} from '../core/report.ts';
import {
  activeAuthorPaths,
  authorSlugs,
  readAuthor,
  upgradeIdentityIfProvisional,
} from '../core/authors.ts';
import { catchUpFromTranscripts, type CatchUpResult } from '../core/catchUp.ts';
import { emitJson } from '../core/output.ts';
import {
  assertProjectCommandIdentity,
  pinProjectCommandIdentity,
  refreshProjectIdentity,
  resolveProjectCommandTarget,
  type ProjectSelection,
} from '../core/projectCatalog.ts';
import { noteTrailAt } from '../core/ledger.ts';
import {
  authorPaths,
  ensureTrailId,
  isPathUnder,
  pathsForRoot,
  readConfig,
  resolveProjectContext,
  samePath,
  writeJson,
  type ShowtailPaths,
} from '../core/storage.ts';
import { ShowtailError } from '../core/errors.ts';
import { claimPendingWork, pendingWorkForRoot, type BackfillResult } from './init.ts';
import { fileLink, openInDefaultApp } from '../core/terminal.ts';
import {
  autoInitEnabled,
  readAutoOpenReport,
  setAutoOpenReport,
} from '../core/globalConfig.ts';
import { toolStatuses } from '../core/tools.ts';
import { type OpenableReport, promptOpenReport } from '../core/prompt.ts';
import { existsSync, lstatSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import type { ReportData } from '../types.ts';
import { pendingRangeSummariesForRoot, type PendingRangeSummary } from './ranges.ts';
import {
  reconcileReportRouting,
  type ReportRoutingReconciliation,
  type ReroutedRange,
} from './reportRouting.ts';

export interface ReportOptions {
  format?: string;
  cwd?: string;
  /** True when cwd came from the optional `report [path]` argument. */
  explicitPath?: boolean;
  /** Select a project by live path, trail id, or corroborated project name. */
  project?: string;
  /** Open the generated report in the OS default app after writing it. */
  open?: boolean;
  /** Generate only this author's report (slugified email). */
  author?: string;
  /** Generate only the combined team report. */
  team?: boolean;
  /** Override the descriptive name shown in the title (beats the project name). */
  title?: string;
  /**
   * How much of the AI's play-by-play to show: `collapsed` (default, behind a
   * disclosure), `full` (expanded), or `off` (omitted). Commander sets `false`
   * for `--no-ai` (which we treat as `off`) and defaults it to `true` otherwise.
   */
  ai?: string | boolean;
  /** Emit machine-readable JSON (the written paths + summary) instead of prose. */
  json?: boolean;
  /** Include full routing, relocation, and pending-work arrays in JSON. */
  verboseJson?: boolean;
  /** Force the open menu this run, ignoring a remembered choice (from `--ask`). */
  ask?: boolean;
  /**
   * Skip the catch-up sweep of the AI tools' own transcripts. Commander sets
   * this `false` for `--no-sync`. The sweep is on by default because a host
   * writes its transcript asynchronously and appends its end-of-turn recap
   * minutes after the last hook ran — so without it a report can be missing the
   * final exchange of a session (see `src/core/catchUp.ts`).
   */
  sync?: boolean;
}

/** Normalize the `--ai` flag (and `--no-ai` → false) to a render mode. */
function aiMode(value: string | boolean | undefined): AiMode {
  if (value === false || value === 'off' || value === 'none') return 'off';
  if (value === 'full' || value === 'all') return 'full';
  return 'collapsed';
}

/**
 * A filesystem-safe timestamp for report filenames, e.g. 2026-06-12T140300123.
 *
 * Milliseconds are kept so two reports generated in the same second are two
 * files: at one-second precision the second run silently overwrote the first,
 * which is surprising for a student who ran `report` twice and expected to keep
 * both.
 */
function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '').replace(/Z$/, '');
}

function ambiguousProjectMessage(message: string, candidates: string[]): string {
  if (candidates.length === 0) return message;
  return `${message}\nCandidate project roots:\n${candidates
    .map((candidate) => `  ${candidate}`)
    .join('\n')}\nRun \`showtail inbox\` to review and place the session.`;
}

function uniqueRoots(roots: string[]): string[] {
  const unique: string[] = [];
  for (const root of roots) {
    const absolute = resolve(root);
    if (!unique.some((candidate) => samePath(candidate, absolute))) unique.push(absolute);
  }
  return unique;
}

function mergePendingAmbiguous(
  ...groups: Array<Array<{ id: string; candidates: string[] }>>
): Array<{ id: string; candidates: string[] }> {
  const merged = new Map<string, string[]>();
  for (const group of groups) {
    for (const item of group) {
      merged.set(
        item.id,
        uniqueRoots([...(merged.get(item.id) ?? []), ...item.candidates]),
      );
    }
  }
  return [...merged].map(([id, candidates]) => ({ id, candidates }));
}

function emptyRoutingReconciliation(): ReportRoutingReconciliation {
  return { reroutedRanges: [], cleanedPendingRanges: [], warnings: [] };
}

function pendingRangesForRoot(root: string, persist = false): PendingRangeSummary[] {
  try {
    return pendingRangeSummariesForRoot(root, { persist });
  } catch {
    return [];
  }
}

function mergeReroutedRanges(
  catchUp: CatchUpResult['reroutedRanges'],
  reconciled: ReroutedRange[],
): ReroutedRange[] {
  const merged = new Map<string, ReroutedRange>();
  for (const item of catchUp ?? []) {
    merged.set(item.selector, {
      id: item.selector,
      sessionId: item.sessionId,
      rangeId: item.segmentId,
      segmentIds: [item.segmentId],
      root: item.root,
      movedFrom: [],
    });
  }
  for (const item of reconciled) {
    const prior = merged.get(item.id);
    merged.set(item.id, {
      ...item,
      movedFrom: uniqueRoots([...(prior?.movedFrom ?? []), ...item.movedFrom]),
    });
  }
  return [...merged.values()];
}

function mergePendingAmbiguousRanges(
  claimed: BackfillResult['pendingAmbiguousRanges'],
  catchUp: CatchUpResult['pendingAmbiguousRanges'],
): BackfillResult['pendingAmbiguousRanges'] {
  const merged = new Map<string, BackfillResult['pendingAmbiguousRanges'][number]>();
  for (const item of claimed) merged.set(item.id, item);
  for (const item of catchUp ?? []) {
    merged.set(item.selector, {
      id: item.selector,
      sessionId: item.sessionId,
      rangeId: item.segmentId,
      segmentIds: [item.segmentId],
      candidates: uniqueRoots(item.candidates),
    });
  }
  return [...merged.values()];
}

/** Whether routing cleanup left substantive work for the requested trail to report. */
function hasReportableWork(paths: ShowtailPaths): boolean {
  const { summary } = buildReportData(paths);
  return summary.events > 0 || summary.artifacts > 0;
}

function noMatchingWorkGuidance(root: string): {
  message: string;
  nextAction: string;
  capture: {
    autoInit: boolean;
    automaticTools: string[];
    connectedTools: string[];
  };
} {
  const autoInit = autoInitEnabled();
  const tools = toolStatuses(root);
  const automaticTools = tools
    .filter((tool) => tool.hooksActive === true || tool.captureActive === true)
    .map((tool) => tool.tool);
  const connectedTools = tools.filter((tool) => tool.connected).map((tool) => tool.tool);
  const prefix = `No captured Showtail work resolves to ${root}.`;
  const capture = { autoInit, automaticTools, connectedTools };

  if (!autoInit) {
    return {
      message: `${prefix} Automatic project trail creation is off; run \`showtail setup\` to enable hands-free project creation.`,
      nextAction: 'run-setup',
      capture,
    };
  }
  if (automaticTools.length === 0) {
    return {
      message: `${prefix} Automatic project trail creation is on, but no connected tool currently has automatic capture. Run \`showtail connect <tool>\`, then keep working in this folder.`,
      nextAction: 'connect-tool',
      capture,
    };
  }
  return {
    message: `${prefix} Automatic project trail creation is on, and capture is active for ${automaticTools.join(', ')}; keep working in this folder, then run the report again.`,
    nextAction: 'keep-working',
    capture,
  };
}

function relocationReviewMessage(
  root: string,
  candidates: Array<
    | BackfillResult['relocationCandidates'][number]
    | BackfillResult['segmentRelocationCandidates'][number]
  >,
): string {
  const noun = candidates.length === 1 ? 'work range looks' : 'work ranges look';
  return [
    `${candidates.length} captured ${noun} like moved work for ${root}, but Showtail cannot relocate it safely without your review.`,
    ...candidates.map(
      (candidate) => `  ${candidate.id}: ${candidate.detail} (${candidate.reason})`,
    ),
    `Review the files, then place a session with \`showtail move <id> --to "${root}"\`.`,
  ].join('\n');
}

/** One report to generate: a filename key, a human label, and the builder scope. */
interface ReportTarget {
  key: string;
  label: string;
  scope: { authorSlug?: string };
}

/** A written report's primary file plus its Markdown source (if any). */
interface WrittenReport {
  key: string;
  label: string;
  format: string;
  reportPath: string;
  markdownPath: string | null;
}

/** Reject values that could turn an author selector into a report path. */
function assertSafeAuthorSlug(slug: string): void {
  if (
    slug.length === 0 ||
    slug.trim() !== slug ||
    slug === '.' ||
    slug === '..' ||
    /[\/\\\0-\x1f\x7f]/.test(slug)
  ) {
    throw new ShowtailError(
      `Invalid author slug: ${JSON.stringify(slug)}.`,
      2,
      { author: slug },
      'INVALID_AUTHOR_SLUG',
      'choose-author',
    );
  }
}

function nearestExistingRealPath(path: string): string | null {
  let candidate = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync.native(candidate));
    } catch {
      try {
        // An existing entry that cannot resolve is a dangling link/reparse point,
        // not an absent child whose parent can safely establish containment.
        lstatSync(candidate);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

/** Reject report directories and files whose existing path chain leaves the project. */
function assertPhysicalReportContainment(projectRoot: string, path: string): void {
  let physicalRoot: string;
  try {
    physicalRoot = resolve(realpathSync.native(projectRoot));
  } catch {
    throw new ShowtailError(
      'Showtail could not verify the selected project before writing its report.',
      2,
      { root: resolve(projectRoot), reportPath: resolve(path) },
      'REPORT_PATH_OUTSIDE_PROJECT',
      'check-project-path',
    );
  }
  const physicalParent = nearestExistingRealPath(path);
  if (!physicalParent || !isPathUnder(physicalParent, physicalRoot)) {
    throw new ShowtailError(
      'Showtail refused to write a report through a path outside the selected project.',
      2,
      { root: resolve(projectRoot), reportPath: resolve(path) },
      'REPORT_PATH_OUTSIDE_PROJECT',
      'check-project-path',
    );
  }
}

/** Resolve one output path and keep every report write inside its report directory. */
function containedReportPath(
  projectRoot: string,
  reportsDir: string,
  filename: string,
): string {
  const root = resolve(reportsDir);
  const out = resolve(root, filename);
  if (!isPathUnder(out, root) || samePath(out, root)) {
    throw new ShowtailError(
      'Showtail refused to write a report outside the selected project.',
      2,
      { reportsDir: root, reportPath: out },
      'REPORT_PATH_OUTSIDE_PROJECT',
      'choose-author',
    );
  }
  assertPhysicalReportContainment(projectRoot, out);
  return out;
}

/** A contributor target keyed by slug, labelled with their display name. */
function authorTarget(paths: ShowtailPaths, slug: string): ReportTarget {
  const label = readAuthor(authorPaths(paths, slug))?.name ?? slug;
  return { key: slug, label, scope: { authorSlug: slug } };
}

/**
 * Decide which reports to write. `--author`/`--team` are explicit. By default:
 * with two or more contributors, the combined team report first, then one each;
 * with a single contributor there is no "team" — just their report; with none,
 * a single default report.
 */
export function reportTargets(
  paths: ShowtailPaths,
  options: ReportOptions,
  slugs: string[],
): ReportTarget[] {
  if (options.author) {
    assertSafeAuthorSlug(options.author);
    return [authorTarget(paths, options.author)];
  }
  if (options.team) {
    return [{ key: 'team', label: 'team', scope: {} }];
  }
  if (slugs.length >= 2) {
    return [
      { key: 'team', label: 'team', scope: {} },
      ...slugs.map((s) => authorTarget(paths, s)),
    ];
  }
  if (slugs.length === 1) {
    return [authorTarget(paths, slugs[0]!)];
  }
  return [{ key: 'team', label: 'team', scope: {} }];
}

/**
 * Generate reports under `.showtail/reports/` and print where they were written.
 * In a multi-student project this writes a combined team report plus one report
 * per contributor by default; `--author <slug>` or `--team` narrows that. HTML
 * by default; the Markdown it renders from is written alongside as the source of
 * truth, and `--format md`/`--format json` switch the primary output. `--json`
 * emits the written paths + summary for an agent instead of prose.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  if (options.author !== undefined) assertSafeAuthorSlug(options.author);
  const callerCwd = resolve(options.cwd ?? process.cwd());
  const hasExplicitTarget =
    options.explicitPath === true || options.project !== undefined;
  const target = options.project
    ? resolveProjectCommandTarget(options.project, {
        cwd: callerCwd,
        allowUntrackedPath: true,
      })
    : null;
  const requested = resolve(target?.root ?? callerCwd);
  const context = resolveProjectContext({
    cwd: requested,
    explicitPath: hasExplicitTarget,
  });
  if (context.state === 'none') {
    throw new ShowtailError(
      `Folder does not exist: ${requested}`,
      2,
      {
        root: null,
        created: false,
        evidence: null,
        claimedSessions: [],
        claimedSegments: [],
        relocatedSessions: [],
        relocatedSegments: [],
        relocationCandidates: [],
        segmentRelocationCandidates: [],
        pendingAmbiguous: [],
        pendingAmbiguousRanges: [],
        pendingRanges: [],
        reroutedSessions: [],
        reroutedRanges: [],
        cleanedPendingRanges: [],
        routingWarnings: [],
        candidates: [],
      },
      'PATH_NOT_FOUND',
      'choose-existing-path',
    );
  }
  if (context.state === 'ambiguous') {
    throw new ShowtailError(
      ambiguousProjectMessage(
        'No single project could be selected for this report.',
        context.candidates,
      ),
      2,
      {
        root: null,
        created: false,
        evidence: null,
        claimedSessions: [],
        claimedSegments: [],
        relocatedSessions: [],
        relocatedSegments: [],
        relocationCandidates: [],
        segmentRelocationCandidates: [],
        pendingAmbiguous: [],
        pendingAmbiguousRanges: [],
        pendingRanges: [],
        reroutedSessions: [],
        reroutedRanges: [],
        cleanedPendingRanges: [],
        routingWarnings: [],
        candidates: context.candidates,
      },
      'AMBIGUOUS_PROJECT',
      'review-inbox',
    );
  }

  const root = context.root;
  let identityPin = pinProjectCommandIdentity(root, target?.selection);
  const initialPendingRanges = pendingRangesForRoot(root);
  const preview = await pendingWorkForRoot(root);
  const hasClaimableWork =
    preview.ranges.length > 0 || preview.safeSegmentRelocations.length > 0;
  const previewRelocationReview = preview.segmentRelocationCandidates;
  const paths = pathsForRoot(root);
  const reviewOnly =
    !hasClaimableWork &&
    previewRelocationReview.length > 0 &&
    (context.state === 'candidate' || !hasReportableWork(paths));
  if (reviewOnly) {
    throw new ShowtailError(
      relocationReviewMessage(root, previewRelocationReview),
      2,
      {
        root,
        created: false,
        evidence: context.evidence,
        claimedSessions: [],
        claimedSegments: [],
        relocatedSessions: [],
        relocatedSegments: [],
        relocationCandidates: preview.relocationCandidates,
        segmentRelocationCandidates: preview.segmentRelocationCandidates,
        pendingAmbiguous: preview.pendingAmbiguous,
        pendingAmbiguousRanges: preview.pendingAmbiguousRanges,
        pendingRanges: initialPendingRanges,
        reroutedSessions: [],
        reroutedRanges: [],
        cleanedPendingRanges: [],
        routingWarnings: [],
        candidates: previewRelocationReview.map(({ id, detail }) => ({
          id,
          detail,
        })),
      },
      'RELOCATION_REVIEW_REQUIRED',
      'review-relocation',
    );
  }

  let created = false;
  if (context.state === 'candidate') {
    if (!hasClaimableWork) {
      if (preview.pendingAmbiguousRanges.length > 0) {
        const candidates = [
          ...new Set(preview.pendingAmbiguousRanges.flatMap((item) => item.candidates)),
        ];
        throw new ShowtailError(
          ambiguousProjectMessage(
            'Captured work spans multiple project roots, so Showtail will not guess which report owns it.',
            candidates,
          ),
          2,
          {
            root,
            created: false,
            evidence: context.evidence,
            claimedSessions: [],
            claimedSegments: [],
            relocatedSessions: [],
            relocatedSegments: [],
            relocationCandidates: [],
            segmentRelocationCandidates: [],
            pendingAmbiguous: preview.pendingAmbiguous,
            pendingAmbiguousRanges: preview.pendingAmbiguousRanges,
            pendingRanges: initialPendingRanges,
            reroutedSessions: [],
            reroutedRanges: [],
            cleanedPendingRanges: [],
            routingWarnings: [],
            candidates,
          },
          'AMBIGUOUS_PROJECT',
          'review-inbox',
        );
      }
      const guidance = noMatchingWorkGuidance(root);
      throw new ShowtailError(
        guidance.message,
        4,
        {
          root,
          created: false,
          evidence: context.evidence,
          claimedSessions: [],
          claimedSegments: [],
          relocatedSessions: [],
          relocatedSegments: [],
          relocationCandidates: [],
          segmentRelocationCandidates: [],
          pendingAmbiguous: [],
          pendingAmbiguousRanges: [],
          pendingRanges: initialPendingRanges,
          reroutedSessions: [],
          reroutedRanges: [],
          cleanedPendingRanges: [],
          routingWarnings: [],
          capture: guidance.capture,
        },
        'NO_MATCHING_WORK',
        guidance.nextAction,
      );
    }
  }

  let claimed: BackfillResult = {
    placed: 0,
    claimedSessions: [],
    claimedSegments: [],
    candidates: [],
    pendingAmbiguous: preview.pendingAmbiguous,
    pendingAmbiguousRanges: preview.pendingAmbiguousRanges,
    relocatedSessions: [],
    relocatedSegments: [],
    relocationCandidates: preview.relocationCandidates,
    segmentRelocationCandidates: preview.segmentRelocationCandidates,
  };
  if (hasClaimableWork) {
    assertProjectCommandIdentity(identityPin);
    // The claim itself creates the destination only after its final relocation
    // revalidation, so a move that becomes a copy/mixed case leaves no empty trail.
    claimed = await claimPendingWork(root, {
      mode: 'resolved',
      initialization: {
        ...(context.evidence === 'trail' ? {} : { anchorKind: context.evidence }),
        initialization: {
          mode: 'report',
          evidence: context.evidence,
        },
      },
      provisionalAuthor: true,
    });
    created = context.state === 'candidate' && claimed.placed > 0;
  }

  if (context.state === 'candidate' && claimed.placed === 0) {
    if (claimed.segmentRelocationCandidates.length > 0) {
      throw new ShowtailError(
        relocationReviewMessage(root, claimed.segmentRelocationCandidates),
        2,
        {
          root,
          created: false,
          evidence: context.evidence,
          claimedSessions: [],
          claimedSegments: [],
          relocatedSessions: [],
          relocatedSegments: [],
          relocationCandidates: claimed.relocationCandidates,
          segmentRelocationCandidates: claimed.segmentRelocationCandidates,
          pendingAmbiguous: claimed.pendingAmbiguous,
          pendingAmbiguousRanges: claimed.pendingAmbiguousRanges,
          pendingRanges: pendingRangesForRoot(root),
          reroutedSessions: [],
          reroutedRanges: [],
          cleanedPendingRanges: [],
          routingWarnings: [],
          candidates: claimed.segmentRelocationCandidates.map(({ id, detail }) => ({
            id,
            detail,
          })),
        },
        'RELOCATION_REVIEW_REQUIRED',
        'review-relocation',
      );
    }
    const guidance = noMatchingWorkGuidance(root);
    throw new ShowtailError(
      guidance.message,
      4,
      {
        root,
        created: false,
        evidence: context.evidence,
        claimedSessions: [],
        claimedSegments: [],
        relocatedSessions: [],
        relocatedSegments: [],
        relocationCandidates: [],
        segmentRelocationCandidates: [],
        pendingAmbiguous: claimed.pendingAmbiguous,
        pendingAmbiguousRanges: claimed.pendingAmbiguousRanges,
        pendingRanges: pendingRangesForRoot(root),
        reroutedSessions: [],
        reroutedRanges: [],
        cleanedPendingRanges: [],
        routingWarnings: [],
        capture: guidance.capture,
      },
      'NO_MATCHING_WORK',
      guidance.nextAction,
    );
  }

  assertProjectCommandIdentity(identityPin);
  const selectedTrailId = ensureTrailId(paths);
  assertProjectCommandIdentity(identityPin);
  identityPin = pinProjectCommandIdentity(root, target?.selection);
  refreshProjectIdentity(paths.root, { expectedTrailId: selectedTrailId });
  // Turn-in checkpoint: if capture has been under a computer-derived placeholder, adopt
  // the student's real identity (gh/git/env) now and re-attribute the work, so the report
  // is under their real name even if they never made a git commit. Best-effort, silent.
  assertProjectCommandIdentity(identityPin);
  await upgradeIdentityIfProvisional(paths, { cwd: paths.root });
  // Generating a report is often the first thing a student does after moving their
  // project, so repoint the ledger index here too — the move then gets noticed
  // without waiting for another AI session (see `noteTrailLocation`).
  assertProjectCommandIdentity(identityPin);
  noteTrailAt(paths.root);
  // Complete the trail before reading it: hosts write their transcripts
  // asynchronously and append the end-of-turn recap after every hook has run, so
  // the last exchange of a session only becomes visible on a later re-read.
  // Best-effort and idempotent — see `src/core/catchUp.ts`.
  let catchUp: CatchUpResult = {
    projected: 0,
    sessions: 0,
    reroutedSessions: [],
    pendingAmbiguous: [],
    reroutedRanges: [],
    pendingAmbiguousRanges: [],
    activeTrailRemoved: false,
  };
  if (options.sync !== false) {
    assertProjectCommandIdentity(identityPin);
    try {
      const active = activeAuthorPaths(paths);
      if (active) catchUp = await catchUpFromTranscripts(active);
    } catch {
      // Never block a report on the sweep; the trail is still fully readable.
    }
  }
  let routing = emptyRoutingReconciliation();
  if (hasExplicitTarget || existsSync(paths.config)) {
    assertProjectCommandIdentity(identityPin);
  }
  try {
    routing = await reconcileReportRouting(root);
  } catch (error) {
    routing.warnings.push({
      id: 'report-routing',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const pendingRanges = pendingRangesForRoot(root);
  const reroutedRanges = mergeReroutedRanges(
    catchUp.reroutedRanges,
    routing.reroutedRanges,
  );
  const pendingAmbiguous = mergePendingAmbiguous(
    claimed.pendingAmbiguous,
    catchUp.pendingAmbiguous,
  );
  const reroutedIds = new Set([
    ...catchUp.reroutedSessions.map((item) => item.id),
    ...catchUp.pendingAmbiguous.map((item) => item.id),
  ]);
  const claimedSessions = claimed.claimedSessions.filter((id) => !reroutedIds.has(id));
  const claimedSegments = claimed.claimedSegments.filter(
    (item) => !reroutedIds.has(item.sessionId),
  );
  const relocatedSessions = claimed.relocatedSessions.filter(
    (item) => !reroutedIds.has(item.id),
  );
  const relocatedSegments = claimed.relocatedSegments.filter(
    (item) => !reroutedIds.has(item.sessionId),
  );
  const relocationCandidates = claimed.relocationCandidates;
  const segmentRelocationCandidates = claimed.segmentRelocationCandidates;
  const pendingAmbiguousRanges = mergePendingAmbiguousRanges(
    claimed.pendingAmbiguousRanges,
    catchUp.pendingAmbiguousRanges,
  );
  const rerouteRoots = uniqueRoots([
    ...catchUp.reroutedSessions.map((item) => item.root),
    ...reroutedRanges.map((item) => item.root),
  ]);
  const rangeRoutingChanged =
    reroutedRanges.some((item) =>
      item.movedFrom.some((source) => samePath(source, root)),
    ) ||
    routing.cleanedPendingRanges.some((item) =>
      item.removedFrom.some((source) => samePath(source, root)),
    ) ||
    (catchUp.pendingAmbiguousRanges?.length ?? 0) > 0;
  const routingChanged =
    catchUp.reroutedSessions.length > 0 ||
    catchUp.pendingAmbiguous.length > 0 ||
    rangeRoutingChanged;
  const sourceStillHasWork =
    routingChanged && existsSync(paths.config) && hasReportableWork(paths);
  // An explicit target is an execution boundary: routing may refile stale work,
  // but report generation must never follow it into a different project.
  if (routingChanged && !sourceStillHasWork && !hasExplicitTarget) {
    if (
      pendingAmbiguous.length === 0 &&
      pendingRanges.length === 0 &&
      rerouteRoots.length === 1
    ) {
      // The sweep already captured the complete transcript into the ledger. Disable
      // it on the redirected run to make this a one-hop handoff, not recursion.
      return runReport({
        ...options,
        cwd: rerouteRoots[0],
        explicitPath: true,
        project: undefined,
        sync: false,
      });
    }

    const candidates = uniqueRoots([
      ...pendingAmbiguous.flatMap((item) => item.candidates),
      ...pendingRanges.flatMap((item) => item.candidates),
      ...rerouteRoots,
    ]);
    throw new ShowtailError(
      ambiguousProjectMessage(
        'The completed transcript spans multiple projects, so Showtail stopped this report rather than choosing one.',
        candidates,
      ),
      2,
      {
        root: null,
        created: false,
        evidence: null,
        claimedSessions,
        claimedSegments,
        relocatedSessions,
        relocatedSegments,
        relocationCandidates,
        segmentRelocationCandidates,
        pendingAmbiguous,
        pendingAmbiguousRanges,
        pendingRanges,
        reroutedSessions: catchUp.reroutedSessions,
        reroutedRanges,
        cleanedPendingRanges: routing.cleanedPendingRanges,
        routingWarnings: routing.warnings,
        candidates,
      },
      'AMBIGUOUS_PROJECT',
      'review-inbox',
    );
  }
  if (catchUp.activeTrailRemoved || !existsSync(paths.config)) {
    throw new ShowtailError(
      'The project trail changed while Showtail was completing this report.',
      2,
      {
        root: null,
        created: false,
        evidence: null,
        claimedSessions,
        claimedSegments,
        relocatedSessions,
        relocatedSegments,
        relocationCandidates,
        segmentRelocationCandidates,
        pendingAmbiguous,
        pendingAmbiguousRanges,
        pendingRanges,
        reroutedSessions: catchUp.reroutedSessions,
        reroutedRanges,
        cleanedPendingRanges: routing.cleanedPendingRanges,
        routingWarnings: routing.warnings,
        candidates: [],
      },
      'TRAIL_CHANGED_DURING_REPORT',
      'run-report-again',
    );
  }
  assertProjectCommandIdentity(identityPin);
  const slugs = authorSlugs(paths);
  const stamp = fileStamp(new Date().toISOString());
  assertProjectCommandIdentity(identityPin);
  assertPhysicalReportContainment(root, paths.reportsDir);
  mkdirSync(paths.reportsDir, { recursive: true });
  assertPhysicalReportContainment(root, paths.reportsDir);

  const targets = reportTargets(paths, options, slugs);
  const written: WrittenReport[] = [];
  let teamData: ReportData | undefined;
  const assertWritableTarget = (out: string) => {
    assertProjectCommandIdentity(identityPin);
    assertPhysicalReportContainment(root, out);
  };

  if (!options.json) {
    console.log(`Showtail project: ${root} (${context.evidence} evidence).`);
    if (created) {
      console.log('Created the project-local .showtail/ trail from captured work.');
    }
    if (claimedSessions.length > 0) {
      console.log(
        `Claimed ${claimedSessions.length} captured session(s) into this project.`,
      );
    }
    if (claimedSegments.length > 0) {
      console.log(
        `Filed ${claimedSegments.length} captured turn range(s) into this project.`,
      );
    }
    if (relocatedSessions.length > 0) {
      console.log(
        `Recovered ${relocatedSessions.length} moved session(s) into this project.`,
      );
      for (const item of relocatedSessions) {
        console.log(`  ${item.id}: ${item.from} -> ${item.to}`);
      }
    }
    if (relocatedSegments.length > 0) {
      console.log(
        `Recovered ${relocatedSegments.length} moved turn range(s) into this project.`,
      );
      for (const item of relocatedSegments) {
        console.log(`  ${item.id}: ${item.from} -> ${item.to}`);
      }
    }
    if (relocationCandidates.length > 0) {
      console.log(
        `${relocationCandidates.length} moved-work session(s) still need review; Showtail left them alone.`,
      );
    }
    if (segmentRelocationCandidates.length > 0) {
      console.log(
        `${segmentRelocationCandidates.length} moved-work turn range(s) still need review; Showtail left them alone.`,
      );
    }
    if (pendingAmbiguous.length > 0) {
      console.log(
        `${pendingAmbiguous.length} multi-project session(s) remain in the inbox; Showtail did not guess.`,
      );
    }
    if (pendingRanges.length > 0) {
      console.log(
        `${pendingRanges.length} turn range(s) from related chats still need placement; Showtail left them in the inbox.`,
      );
      for (const range of pendingRanges) {
        console.log(`  ${range.id}: ${range.reason}`);
      }
    }
    if (catchUp.reroutedSessions.length > 0) {
      console.log(
        `${catchUp.reroutedSessions.length} completed session(s) now resolve to another project and were returned to the inbox.`,
      );
      for (const item of catchUp.reroutedSessions) {
        console.log(`  ${item.id} -> ${item.root}`);
      }
    }
    if (reroutedRanges.length > 0) {
      console.log(
        `${reroutedRanges.length} turn range(s) were filed with their actual project instead of this report.`,
      );
      for (const item of reroutedRanges) console.log(`  ${item.id} -> ${item.root}`);
    }
    if (routing.warnings.length > 0) {
      console.log(
        `${routing.warnings.length} turn range(s) could not be reconciled automatically; their existing records were left intact.`,
      );
      for (const warning of routing.warnings) {
        console.log(`  ${warning.id}: ${warning.message}`);
      }
    }
  }

  for (const target of targets) {
    assertProjectCommandIdentity(identityPin);
    const data = buildReportData(paths, { ...target.scope, title: options.title });
    if (target.key === 'team') teamData = data;
    assertProjectCommandIdentity(identityPin);
    written.push(
      writeOneReport(
        root,
        paths.reportsDir,
        target,
        stamp,
        data,
        options,
        assertWritableTarget,
      ),
    );
  }

  const primary = written[0];
  const summarySource = teamData ?? (await firstData(paths, targets));

  if (options.json) {
    if (options.open && primary) openInDefaultApp(primary.reportPath);
    const verboseRouting = {
      claimedSessions,
      claimedSegments,
      relocatedSessions,
      relocatedSegments,
      relocationCandidates,
      segmentRelocationCandidates,
      pendingAmbiguous,
      pendingAmbiguousRanges,
      pendingRanges,
      reroutedSessions: catchUp.reroutedSessions,
      reroutedRanges,
      cleanedPendingRanges: routing.cleanedPendingRanges,
      routingWarnings: routing.warnings,
    };
    emitJson({
      ok: true,
      root,
      trailId: selectedTrailId ?? null,
      ...(target?.selection
        ? { selection: target.selection satisfies ProjectSelection }
        : {}),
      created,
      evidence: context.evidence,
      routing: {
        claimedSessions: claimedSessions.length,
        claimedSegments: claimedSegments.length,
        relocatedSessions: relocatedSessions.length,
        relocatedSegments: relocatedSegments.length,
        relocationCandidates: relocationCandidates.length,
        segmentRelocationCandidates: segmentRelocationCandidates.length,
        pendingAmbiguous: pendingAmbiguous.length,
        pendingAmbiguousRanges: pendingAmbiguousRanges.length,
        pendingRanges: pendingRanges.length,
        reroutedSessions: catchUp.reroutedSessions.length,
        reroutedRanges: reroutedRanges.length,
        cleanedPendingRanges: routing.cleanedPendingRanges.length,
        warnings: routing.warnings.length,
      },
      format: options.format ?? 'html',
      reportPath: primary?.reportPath ?? null,
      markdownPath: primary?.markdownPath ?? null,
      summary: summarySource?.summary ?? null,
      reports: written,
      ...(options.verboseJson ? verboseRouting : {}),
    });
    return;
  }

  if (summarySource) {
    console.log('');
    console.log(
      `Summary: ${summarySource.summary.sessions} session(s), ` +
        `${summarySource.summary.events} event(s), ` +
        `${summarySource.summary.artifacts} artifact record(s)` +
        (summarySource.contributors.length > 1
          ? `, ${summarySource.contributors.length} contributor(s)`
          : '') +
        '.',
    );
  }

  if (primary) await offerToOpen(written, primary, options);
}

/** Write one report in the requested format; return its written paths. */
function writeOneReport(
  projectRoot: string,
  reportsDir: string,
  target: ReportTarget,
  stamp: string,
  data: ReportData,
  options: ReportOptions,
  assertWritableTarget: (out: string) => void,
): WrittenReport {
  const { key, label } = target;
  const base = `report-${key}-${stamp}`;
  const format = options.format ?? 'html';
  const quiet = options.json === true;
  const renderOpts: ReportRenderOptions = { ai: aiMode(options.ai) };
  // The printed link's text is the full path: the click target where the terminal
  // renders OSC 8 hyperlinks, and — everywhere else — the location itself, so it can
  // be read and copied. A basename alone says nothing about where the file landed.
  const link = (out: string) => fileLink(out);

  if (format === 'json') {
    const out = containedReportPath(projectRoot, reportsDir, `${base}.json`);
    assertWritableTarget(out);
    writeJson(out, data);
    if (!quiet) console.log(`Wrote JSON report (${key}): ${link(out)}`);
    return { key, label, format, reportPath: out, markdownPath: null };
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = containedReportPath(projectRoot, reportsDir, `${base}.md`);
  const htmlOut = containedReportPath(projectRoot, reportsDir, `${base}.html`);
  const markdown = renderMarkdown(data, renderOpts) + '\n';
  assertWritableTarget(mdOut);
  writeFileSync(mdOut, markdown, 'utf8');

  if (format === 'md') {
    if (!quiet) console.log(`Wrote report (${key}): ${link(mdOut)}`);
    return { key, label, format, reportPath: mdOut, markdownPath: null };
  }
  const html = renderHtml(data, renderOpts);
  assertWritableTarget(htmlOut);
  writeFileSync(htmlOut, html, 'utf8');
  if (!quiet) console.log(`Wrote report (${key}): ${link(htmlOut)}`);
  return { key, label, format, reportPath: htmlOut, markdownPath: mdOut };
}

/** Fallback summary source when no team report was generated (e.g. `--author`). */
async function firstData(
  paths: ShowtailPaths,
  targets: ReportTarget[],
): Promise<ReportData | undefined> {
  const first = targets[0];
  if (!first) return undefined;
  return buildReportData(paths, first.scope);
}

/**
 * Decide what to do about opening the report, without side effects (testable):
 * honour `--open`/`--no-open`/`--json` first, never touch a non-interactive run,
 * then apply the remembered preference, falling back to prompting.
 */
export function resolveOpenAction(
  opts: { open?: boolean; json?: boolean; ask?: boolean },
  pref: 'always' | 'never' | 'ask',
  interactive: boolean,
): 'open' | 'skip' | 'ask' {
  if (opts.open === true) return 'open'; // --open: open the primary report once
  if (opts.open === false) return 'skip'; // --no-open
  if (opts.json) return 'skip';
  if (!interactive) return 'skip'; // piped/CI/agent: never auto-open, never prompt
  if (opts.ask) return 'ask'; // --ask: show the menu even if a choice is remembered
  if (pref === 'always') return 'open';
  if (pref === 'never') return 'skip';
  return 'ask';
}

/**
 * After writing, open the report per the resolved action: launch it directly, or
 * show the once/always/never menu and act on (and remember) the choice.
 */
async function offerToOpen(
  written: WrittenReport[],
  primary: WrittenReport,
  options: ReportOptions,
): Promise<void> {
  const interactive = (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
  const action = resolveOpenAction(options, readAutoOpenReport(), interactive);
  if (action === 'skip') return;
  if (action === 'open') {
    openInDefaultApp(primary.reportPath);
    return;
  }
  const openable: OpenableReport[] = written.map((w) => ({
    label: w.label,
    path: w.reportPath,
  }));
  const choice = await promptOpenReport(openable, {
    label: primary.label,
    path: primary.reportPath,
  });
  if (choice.kind === 'open') openInDefaultApp(choice.path);
  else if (choice.kind === 'always') {
    setAutoOpenReport('always');
    openInDefaultApp(primary.reportPath);
  } else if (choice.kind === 'never') setAutoOpenReport('never');
}
