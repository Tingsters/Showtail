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
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeAuthorPaths, requireActiveAuthor } from '../core/authors.ts';
import { removeEventsByBatch } from '../core/events.ts';
import { ledgerBatchId, materializeLedgerSession } from '../core/materialize.ts';
import {
  knownTrailPath,
  markPlaced,
  resolveLedgerSessionId,
  unlinkPlacement,
  type LedgerSession,
} from '../core/ledger.ts';
import {
  matchSessionToRoot,
  type CandidateIndex,
  type PathRebase,
} from '../core/relocate.ts';
import { ensureTrailId, pathsForRoot } from '../core/storage.ts';
import { ensureInitialized } from './init.ts';

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
  const { paths } = await ensureInitialized(root);
  const trailId = ensureTrailId(paths);
  const author = await requireActiveAuthor(paths, { cwd: root });

  // Lift any prior projection out of OTHER trails so the work lands in one place.
  const movedFrom: string[] = [];
  for (const target of session.targets ?? []) {
    if (target.trailId === trailId) continue;
    const oldRoot = knownTrailPath(target.trailId) ?? target.path;
    if (!existsSync(join(oldRoot, '.showtail', 'config.json'))) {
      // The old trail is gone (deleted/moved); just forget the placement.
      unlinkPlacement(session.id, target.trailId);
      continue;
    }
    const oldAuthor = activeAuthorPaths(pathsForRoot(oldRoot));
    if (oldAuthor) {
      const removed = removeEventsByBatch(oldAuthor, ledgerBatchId(session.id));
      if (removed > 0) movedFrom.push(oldRoot);
    }
    unlinkPlacement(session.id, target.trailId);
  }

  const { projected, stubs } = await materializeLedgerSession(session, author, {
    rebase: options.rebase,
  });
  markPlaced(session.id, trailId, root);
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
  let rebase: PathRebase | undefined;
  try {
    const match = await matchSessionToRoot(session, resolve(toPath), {}, index);
    rebase = match?.rebase;
  } catch {
    // Path-quality optimization only — never let it block the placement itself.
  }
  return reattachLedgerSession(session, toPath, { rebase });
}

/** The "some edits kept only their name" note, shared by every placement caller. */
export function stubNote(stubs: number): void {
  if (stubs <= 0) return;
  console.log(
    `  Note: ${stubs} edit(s) are recorded by name only — no content was captured ` +
      'for them and the file is no longer readable here.',
  );
}
