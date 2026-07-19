/**
 * Upgrade a computer-derived *provisional* author to the student's real identity, once
 * one appears (git/gh/env). Because the machine-local ledger is the source of truth and
 * `materializeLedgerSession` re-derives attribution from whatever author it's given, we
 * simply re-project this machine's provisional sessions (in this trail) under the real
 * author, then delete the placeholder author folder outright — which also clears its
 * un-batched snapshot artifacts. No journal rewriting, no folder rename.
 *
 * Kept in its own module so `authors.ts` can `import()` it lazily (it pulls in the ledger
 * + materialize graph). Best-effort throughout; a failure leaves the placeholder in place
 * (nothing lost) rather than disrupting the caller.
 */
import { rmSync } from 'node:fs';
import { slugifyEmail, type Identity } from './identity.ts';
import { allLedgerSessions, readLedgerSession, writeLedgerSession } from './ledger.ts';
import { materializeLedgerSession } from './materialize.ts';
import { ensureTrailId, type AuthorPaths, type ShowtailPaths } from './storage.ts';

export async function upgradeProvisionalAuthor(
  paths: ShowtailPaths,
  provisionalAuthor: AuthorPaths,
  realAuthor: AuthorPaths,
  machineId: string,
  real: Identity,
): Promise<void> {
  const trailId = ensureTrailId(paths);
  const realSlug = slugifyEmail(real.email);

  for (const session of allLedgerSessions()) {
    // Only this machine's work, and only sessions placed in THIS trail.
    if (session.machineId && session.machineId !== machineId) continue;
    const placedHere = (session.targets ?? []).some((t) => t.trailId === trailId);
    if (!placedHere) continue;

    try {
      await materializeLedgerSession(session, realAuthor); // re-project under real author
    } catch {
      /* skip a bad session; the others still upgrade */
    }
    try {
      // Keep the ledger's slug hint correct (cosmetic; materialize ignores it).
      const ls = readLedgerSession(session.id);
      if (ls && ls.slug !== realSlug) {
        ls.slug = realSlug;
        writeLedgerSession(ls);
      }
    } catch {
      /* cosmetic only */
    }
  }

  // Remove the placeholder folder entirely — clears its events AND un-batched artifacts,
  // so the real author folder is the single, correctly-attributed copy.
  try {
    rmSync(provisionalAuthor.dir, { recursive: true, force: true });
  } catch {
    /* leave it; worst case the report briefly shows both until the next run */
  }
}
