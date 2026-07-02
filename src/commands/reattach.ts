/**
 * `showtail reattach <sessionId> --to <path>` — place an unplaced (inbox) session
 * into a project, or correct a misattributed one by moving it. It (re-)materializes
 * the ledger session into the chosen repo and, when the session was previously
 * projected into a *different* trail, removes that stale projection so the work
 * ends up in exactly one place. Idempotent: re-running into the same repo projects
 * nothing new (the projection dedupes by source id).
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
}

/**
 * Place `session` into the trail at `toPath`, moving it off any other trail it
 * was previously projected into. Shared by the `reattach` command and the
 * interactive `inbox` picker.
 */
export async function reattachLedgerSession(
  session: LedgerSession,
  toPath: string,
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

  const { projected } = await materializeLedgerSession(session, author);
  markPlaced(session.id, trailId, root);
  return { root, projected, movedFrom };
}

/** CLI entry point for `showtail reattach`. */
export async function runReattach(
  sessionId: string,
  opts: { to?: string; cwd?: string },
): Promise<void> {
  const session = resolveLedgerSessionId(sessionId);
  if (!session) {
    throw new Error(
      `No ledger session matching "${sessionId}". ` +
        'Run `showtail inbox` to see unplaced sessions.',
    );
  }
  const toPath = opts.to ?? opts.cwd ?? process.cwd();
  const { root, projected, movedFrom } = await reattachLedgerSession(session, toPath);

  if (movedFrom.length > 0) {
    console.log(`Moved session ${session.id} off ${movedFrom.join(', ')}.`);
  }
  console.log(
    `Placed session ${session.id} into ${root} — ${projected} record(s) projected.`,
  );
  console.log('Run `showtail report` there to see it alongside your other work.');
}
