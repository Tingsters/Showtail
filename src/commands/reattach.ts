/**
 * The placement core behind `showtail move` (and its `reattach` alias): put an
 * unplaced (inbox) session into a project, or correct a misattributed one. It
 * (re-)materializes the ledger session into the chosen repo and, when the session
 * was previously projected into a *different* trail, removes that stale projection
 * so the work ends up in exactly one place. Idempotent: re-running into the same
 * repo projects nothing new (the projection dedupes by source id).
 *
 * There is no `runReattach` CLI entry — `src/cli.ts` routes both `move` and the
 * `reattach` alias to `runMove`, so a second entry point here was dead code whose
 * output (notably the stub note) never reached a user.
 */
import { resolve } from 'node:path';
import { requireActiveAuthor, resolveActiveAuthorForHook } from '../core/authors.ts';
import { ShowtailError } from '../core/errors.ts';
import {
  assertLedgerSegmentContained,
  assertLedgerSessionContained,
  materializeLedgerSession,
  ProjectionOutsideRootError,
} from '../core/materialize.ts';
import {
  ensureLedgerSegments,
  ledgerSegmentProjectContext,
  markInbox,
  markPlaced,
  readLedgerSession,
  resolveLedgerSessionId,
  sessionProjectContext,
  trailExistsAt,
  type LedgerRangeView,
  type LedgerSession,
} from '../core/ledger.ts';
import {
  matchLedgerSegmentToRoot,
  matchSessionToRoot,
  type CandidateIndex,
  type PathRebase,
} from '../core/relocate.ts';
import {
  removeOtherLedgerProjections,
  reprojectLedgerSegment,
} from '../core/projectionRouting.ts';
import { ensureTrailId, samePath } from '../core/storage.ts';
import { ensureInitialized, type EnsureInitOptions } from './init.ts';

/** The outcome of placing a session, for the caller to report. */
export interface ReattachResult {
  /** Absolute path of the repo the session was placed into. */
  root: string;
  /** How many records were newly projected (0 on a re-run). */
  projected: number;
  /** Repos a prior, now-removed projection was lifted out of. */
  movedFrom: string[];
  /** Edits projected as content-free stubs (nothing captured, file unreadable). */
  stubs: number;
}

export interface ReattachOptions {
  /**
   * Old-root → new-root mapping when this placement is a *relocation* (the student
   * moved their files), so projected edit paths are rebased instead of rendering as
   * `../../..`. Supplied by the relocation matcher; absent for a normal placement.
   */
  rebase?: PathRebase;
  /** Per-turn moves when one native chat spans several project folders. */
  segmentRebases?: Record<string, PathRebase | undefined>;
  /** Preserve the initialization evidence when placement creates the trail. */
  initialization?: EnsureInitOptions;
  /** Use the same non-interactive provisional identity path as automatic capture. */
  provisionalAuthor?: boolean;
}

function copiedTrailSource(
  targets: Array<{ trailId: string; path: string }>,
  destination: string,
): { trailId: string; path: string } | undefined {
  return targets.find(
    (target) =>
      !samePath(target.path, destination) &&
      trailExistsAt(target.path, target.trailId) &&
      trailExistsAt(destination, target.trailId),
  );
}

/** A copied trail id cannot identify which live projection should be replaced. */
function assertNoCopiedTrailMigration(
  selector: string,
  targets: Array<{ trailId: string; path: string }>,
  destination: string,
): void {
  const source = copiedTrailSource(targets, destination);
  if (!source) return;
  throw new ShowtailError(
    `Trail ${source.trailId} is live at both ${source.path} and ${destination}. Showtail refused to move work between copied trails.`,
    2,
    {
      selector,
      trailId: source.trailId,
      sourceRoot: source.path,
      destinationRoot: destination,
    },
    'DUPLICATE_TRAIL_ID',
    'repair-copied-trail',
  );
}

/** Place one command-level turn range without moving neighboring chat turns. */
export async function reattachLedgerRange(
  range: LedgerRangeView,
  toPath: string,
  options: ReattachOptions = {},
): Promise<ReattachResult> {
  const root = resolve(toPath);
  const current = readLedgerSession(range.session.id) ?? range.session;
  assertNoCopiedTrailMigration(
    range.selector,
    [
      ...(current.targets ?? []),
      ...range.segments.flatMap((segment) => segment.targets ?? []),
    ],
    root,
  );
  const document = ensureLedgerSegments(current);
  const segments = range.memberSegmentIds.flatMap((segmentId) => {
    const segment = document.segments.find((candidate) => candidate.id === segmentId);
    return segment ? [segment] : [];
  });
  try {
    for (const segment of segments) {
      assertLedgerSegmentContained(
        current,
        segment,
        root,
        options.segmentRebases?.[segment.id] ?? options.rebase,
      );
    }
  } catch (error) {
    if (!(error instanceof ProjectionOutsideRootError)) throw error;
    throw new ShowtailError(
      `Work range ${range.selector} includes an edit outside ${root}; choose a project root that contains every edited file in this turn.`,
      2,
      { selector: range.selector, sessionId: current.id, root, file: error.file },
      'EDIT_OUTSIDE_PROJECT',
      'choose-project-root',
    );
  }

  const { paths } = options.initialization
    ? await ensureInitialized(root, options.initialization)
    : await ensureInitialized(root);
  const trailId = ensureTrailId(paths);
  const author = options.provisionalAuthor
    ? await resolveActiveAuthorForHook(paths, { cwd: root })
    : await requireActiveAuthor(paths, { cwd: root });
  if (!author)
    throw new Error('Could not establish an author for the destination trail.');

  let projected = 0;
  let stubs = 0;
  const movedFrom: string[] = [];
  for (const segment of segments) {
    const result = await reprojectLedgerSegment(
      readLedgerSession(current.id) ?? current,
      segment.id,
      author,
      trailId,
      root,
      { rebase: options.segmentRebases?.[segment.id] ?? options.rebase },
    );
    projected += result.materialized.projected;
    stubs += result.materialized.stubs;
    movedFrom.push(...result.movedFrom);
  }
  return { root, projected, movedFrom: [...new Set(movedFrom)], stubs };
}

/**
 * Place `session` into the trail at `toPath`, moving it off any other trail it
 * was previously projected into. Shared by the `reattach` command and the
 * interactive `inbox` picker.
 */
export async function reattachLedgerSession(
  session: LedgerSession,
  toPath: string,
  options: ReattachOptions = {},
): Promise<ReattachResult> {
  const root = resolve(toPath);
  const current = readLedgerSession(session.id) ?? session;
  assertNoCopiedTrailMigration(current.id, current.targets ?? [], root);
  const context = sessionProjectContext(current);
  if (context.state === 'ambiguous') {
    // A destination choice cannot turn one multi-project session into a partial
    // projection. Remove any earlier placement and keep the complete work pending.
    removeOtherLedgerProjections(current);
    markInbox(current.id);
    throw new ShowtailError(
      `Session ${current.id} spans multiple projects and cannot be moved as one project trail.`,
      2,
      { sessionId: current.id, candidates: context.candidates },
      'AMBIGUOUS_SESSION',
      'review-inbox',
    );
  }
  try {
    assertLedgerSessionContained(current, root, options.rebase);
  } catch (error) {
    if (!(error instanceof ProjectionOutsideRootError)) throw error;
    throw new ShowtailError(
      `Session ${current.id} includes an edit outside ${root}; choose a project root that contains every edited file.`,
      2,
      { sessionId: current.id, root, file: error.file },
      'EDIT_OUTSIDE_PROJECT',
      'choose-project-root',
    );
  }
  const { paths } = options.initialization
    ? await ensureInitialized(root, options.initialization)
    : await ensureInitialized(root);
  const trailId = ensureTrailId(paths);
  const author = options.provisionalAuthor
    ? await resolveActiveAuthorForHook(paths, { cwd: root })
    : await requireActiveAuthor(paths, { cwd: root });
  if (!author) {
    throw new Error('Could not establish an author for the destination trail.');
  }

  // Lift any prior projection out of OTHER trails so the work lands in one place.
  const movedFrom = removeOtherLedgerProjections(current, trailId);

  const { projected, stubs } = await materializeLedgerSession(current, author, {
    rebase: options.rebase,
  });
  markPlaced(current.id, trailId, root, { pathRebase: options.rebase });
  return { root, projected, movedFrom, stubs };
}

/**
 * Place a session, first deriving a relocation rebase when its recorded paths no
 * longer resolve. **Every user-facing placement path should call this** rather than
 * {@link reattachLedgerSession} directly: without the rebase, a student who moved
 * their files gets edit paths projected as `../../..` escapes out of their own
 * project (and, for edits with no captured diff, a content-free stub as well).
 *
 * Note the match is consulted *only* for the path mapping here — never to decide
 * whether the session belongs in this folder. The user named the folder explicitly,
 * so even Tier-B evidence is fine to take a rebase from; the "confirm before
 * attributing" rule applies to automatic backfill, not to an explicit instruction.
 *
 * Pass `index` when placing several sessions into one folder so it is walked and
 * hashed once.
 */
export async function placeLedgerSession(
  session: LedgerSession,
  toPath: string,
  index?: CandidateIndex,
): Promise<ReattachResult> {
  const target = resolve(toPath);
  let rebase: PathRebase | undefined;
  try {
    const match = await matchSessionToRoot(session, target, {}, index);
    rebase = match?.rebase;
  } catch {
    // Path-quality optimization only — never let it block the placement itself.
  }
  if (!rebase) {
    const context = sessionProjectContext(readLedgerSession(session.id) ?? session);
    if (
      (context.state === 'tracked' || context.state === 'candidate') &&
      !samePath(context.root, target)
    ) {
      // An explicit move changes the project boundary even when no old file is
      // still readable enough for relocation matching. Rebase the deterministic
      // old root as a unit; ambiguous sessions are rejected by the core below.
      rebase = { fromRoot: context.root, toRoot: target };
    }
  }
  return reattachLedgerSession(session, target, { rebase });
}

/** Resolve move evidence independently for every turn represented by a range. */
export async function placeLedgerRangeInProject(
  range: LedgerRangeView,
  toPath: string,
  index?: CandidateIndex,
  options: Omit<ReattachOptions, 'rebase' | 'segmentRebases'> = {},
): Promise<ReattachResult> {
  const target = resolve(toPath);
  const current = readLedgerSession(range.session.id) ?? range.session;
  assertNoCopiedTrailMigration(
    range.selector,
    [
      ...(current.targets ?? []),
      ...range.segments.flatMap((segment) => segment.targets ?? []),
    ],
    target,
  );
  const document = ensureLedgerSegments(current);
  const segmentRebases: Record<string, PathRebase | undefined> = {};
  for (const segmentId of range.memberSegmentIds) {
    const segment = document.segments.find((candidate) => candidate.id === segmentId);
    if (!segment) continue;
    try {
      segmentRebases[segment.id] = (
        await matchLedgerSegmentToRoot(current, segment, target, {}, index)
      )?.rebase;
    } catch {
      // Content matching only improves path quality; explicit placement still wins.
    }
    if (!segmentRebases[segment.id]) {
      const context = ledgerSegmentProjectContext(current, segment);
      if (
        (context.state === 'tracked' || context.state === 'candidate') &&
        !samePath(context.root, target)
      ) {
        segmentRebases[segment.id] = { fromRoot: context.root, toRoot: target };
      }
    }
  }
  return reattachLedgerRange(range, target, { ...options, segmentRebases });
}

/** The "some edits kept only their name" note, shared by every placement caller. */
export function stubNote(stubs: number): void {
  if (stubs <= 0) return;
  console.log(
    `  Note: ${stubs} edit(s) are recorded by name only — no content was captured ` +
      'for them and the file is no longer readable here.',
  );
}
