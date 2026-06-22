/**
 * The append-only, machine-sharded journal: one segment file per machine shard,
 * rolled by size. Sharding by machine means the *same* student working from two
 * machines writes to two different segment files, so even that case never
 * produces a git merge conflict on the journal. This is pure file I/O over the
 * per-author paths; the higher-level event/artifact logging lives in events.ts /
 * artifacts.ts.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../types.ts';
import { appendJsonl, readJsonl, writeJsonl, type AuthorPaths } from './storage.ts';

/** Roll to a new journal segment once the active one passes this size. */
const JOURNAL_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Current journal-entry schema version (see {@link normalizeEntry}). */
export const JOURNAL_ENTRY_VERSION = 1;

/**
 * The machine-shard directory new entries are written under. Sharding the
 * journal by machine means the *same* student working from two machines writes
 * to two different segment files, so even that case never produces a git merge
 * conflict on the journal.
 */
function machineShardDir(author: AuthorPaths): string {
  if (!author.machineId) {
    throw new Error('Cannot append to the journal without a machineId.');
  }
  return join(author.journalDir, author.machineId);
}

/** Every journal segment file (across all machine shards), oldest first. */
function journalSegments(author: AuthorPaths): string[] {
  if (!existsSync(author.journalDir)) return [];
  const out: string[] = [];
  for (const shard of readdirSync(author.journalDir)) {
    const shardDir = join(author.journalDir, shard);
    let entries: string[];
    try {
      entries = readdirSync(shardDir);
    } catch {
      continue; // Not a directory (defensive) — skip.
    }
    for (const f of entries) {
      if (/^\d+\.log$/.test(f)) out.push(join(shardDir, f));
    }
  }
  // Sort by shard then segment number — deterministic across reads. Cross-shard
  // ordering is otherwise irrelevant: readers re-sort events by timestamp.
  return out.sort();
}

/** The segment file new entries should append to (in this machine's shard). */
function activeSegment(author: AuthorPaths): string {
  const shardDir = machineShardDir(author);
  let names: string[] = [];
  if (existsSync(shardDir)) {
    names = readdirSync(shardDir)
      .filter((f) => /^\d+\.log$/.test(f))
      .sort();
  }
  const last = names[names.length - 1];
  if (!last) return join(shardDir, '0001.log');
  const file = join(shardDir, last);
  // Roll to a fresh segment once the current one passes the size cap.
  if (statSync(file).size >= JOURNAL_SEGMENT_MAX_BYTES) {
    const n = Number(last.replace('.log', '')) + 1;
    return join(shardDir, `${String(n).padStart(4, '0')}.log`);
  }
  return file;
}

/** Bring an older/looser entry up to the current shape. Additive-only so far. */
export function normalizeEntry(raw: Record<string, unknown>): JournalEntry {
  const entry = raw as unknown as JournalEntry;
  return {
    ...entry,
    v: typeof raw.v === 'number' ? (raw.v as number) : JOURNAL_ENTRY_VERSION,
  };
}

/** Append one journal entry to this author+machine's active segment. */
export function appendJournal(author: AuthorPaths, entry: JournalEntry): void {
  appendJsonl(activeSegment(author), entry);
}

/** Read every journal entry for one author across all segments, in write order. */
export function readJournal(author: AuthorPaths): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const seg of journalSegments(author)) {
    for (const raw of readJsonl<Record<string, unknown>>(seg)) {
      out.push(normalizeEntry(raw));
    }
  }
  return out;
}

/**
 * Rewrite one author's journal, keeping only entries for which `keep` returns
 * true, and return how many were dropped. Used to remove a batch (e.g. `import
 * undo`). Rewrites affected segments only; objects are left for a future GC.
 */
export function rewriteJournal(
  author: AuthorPaths,
  keep: (entry: JournalEntry) => boolean,
): number {
  let removed = 0;
  for (const file of journalSegments(author)) {
    const entries = readJsonl<Record<string, unknown>>(file).map(normalizeEntry);
    const kept = entries.filter(keep);
    if (kept.length !== entries.length) {
      removed += entries.length - kept.length;
      writeJsonl(file, kept);
    }
  }
  return removed;
}
