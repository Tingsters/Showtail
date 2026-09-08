/** Keep a ledger session projected into only the project that currently owns it. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { activeAuthorPaths } from './authors.ts';
import { removeEventsByBatch } from './events.ts';
import { knownTrailPath, unlinkPlacement, type LedgerSession } from './ledger.ts';
import { ledgerBatchId } from './materialize.ts';
import { pathsForRoot } from './storage.ts';

/**
 * Remove this session's projection from every trail except `keepTrailId`.
 * The ledger remains the source of truth, so a later materialization recreates
 * the complete session in the correct project without losing captured work.
 */
export function removeOtherLedgerProjections(
  session: LedgerSession,
  keepTrailId?: string,
): string[] {
  const movedFrom: string[] = [];
  for (const target of session.targets ?? []) {
    if (target.trailId === keepTrailId) continue;
    const oldRoot = knownTrailPath(target.trailId) ?? target.path;
    if (existsSync(join(oldRoot, '.showtail', 'config.json'))) {
      const oldAuthor = activeAuthorPaths(pathsForRoot(oldRoot));
      if (oldAuthor) {
        const removed = removeEventsByBatch(oldAuthor, ledgerBatchId(session.id));
        if (removed > 0) movedFrom.push(oldRoot);
      }
    }
    unlinkPlacement(session.id, target.trailId);
  }
  return movedFrom;
}
