/** Append-only transcript migration audits and metadata overlays. */
import type { EnrichmentRecord, EventEnrichmentOverlay, JournalEntry } from '../types.ts';
import { makeId } from './ids.ts';
import { appendJournal, JOURNAL_ENTRY_VERSION, readJournal } from './journal.ts';
import type { AuthorPaths } from './storage.ts';

/** Append one migration audit record to the current author's journal shard. */
export function recordEnrichment(
  author: AuthorPaths,
  enrichment: EnrichmentRecord,
): string {
  const id = makeId('mig');
  const entry: JournalEntry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'enrichment',
    id,
    ts: enrichment.migratedAt,
    type: 'enrichment',
    tool: enrichment.provider,
    conv: enrichment.showtailSessionId,
    actorSlug: author.slug,
    batch: enrichment.batchId,
    textPreview: `Recovered ${enrichment.provider} session ${enrichment.providerSessionId}`,
    enrichment,
  };
  appendJournal(author, entry);
  return id;
}

/** Migration audits in append order. */
export function readEnrichments(author: AuthorPaths): EnrichmentRecord[] {
  return readJournal(author)
    .filter((entry) => entry.kind === 'enrichment' && entry.enrichment)
    .map((entry) => entry.enrichment!);
}

/** Latest overlay for every existing event id, folded in append order. */
export function eventEnrichmentOverlays(
  author: AuthorPaths,
): Map<string, EventEnrichmentOverlay> {
  const out = new Map<string, EventEnrichmentOverlay>();
  for (const record of readEnrichments(author)) {
    for (const overlay of record.overlays ?? []) {
      out.set(overlay.targetEventId, {
        ...out.get(overlay.targetEventId),
        ...overlay,
      });
    }
  }
  return out;
}

/** Transcript digests already migrated into a particular Showtail session. */
export function migratedTranscriptDigests(
  author: AuthorPaths,
  sessionId?: string,
): Set<string> {
  return new Set(
    readEnrichments(author)
      .filter((record) => !sessionId || record.showtailSessionId === sessionId)
      .map((record) => record.transcriptSha256),
  );
}

/** Most recently appended migration batch for this author. */
export function latestMigrationBatchId(author: AuthorPaths): string | undefined {
  return readEnrichments(author).at(-1)?.batchId;
}
