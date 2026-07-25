/**
 * The append-only, machine-sharded journal: one segment file per machine shard,
 * rolled by size. Sharding by machine means the *same* student working from two
 * machines writes to two different segment files, so even that case never
 * produces a git merge conflict on the journal. This is pure file I/O over the
 * per-author paths; the higher-level event/artifact logging lives in events.ts /
 * artifacts.ts.
 *
 * Each entry also carries `prev`, the hash of the line before it *in the same
 * shard* — a hash chain. That makes the log tamper-evident: rewriting a past
 * prompt changes that line's hash, so the next line's `prev` no longer matches
 * and `showtail verify` says so. The chain deliberately never spans a shard
 * boundary, which is what keeps two machines' (or two students') segments
 * mergeable without conflict.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JournalEntry } from '../types.ts';
import { sha256OfString } from './hash.ts';
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

/** Every machine-shard directory for one author, sorted (deterministic reads). */
function shardIds(author: AuthorPaths): string[] {
  if (!existsSync(author.journalDir)) return [];
  return readdirSync(author.journalDir)
    .filter((name) => {
      try {
        return statSync(join(author.journalDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** The segment files inside one machine shard, oldest first. */
function segmentsInShard(shardDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(shardDir);
  } catch {
    return [];
  }
  return names
    .filter((f) => /^\d+\.log$/.test(f))
    .sort()
    .map((f) => join(shardDir, f));
}

/**
 * Every journal segment file for one author (across all machine shards), oldest
 * first — the files that must only ever grow. Exported so `verify` can hold the
 * segments up against an outside record of them (git history) without
 * re-deriving the layout.
 */
export function journalSegmentPaths(author: AuthorPaths): string[] {
  const out: string[] = [];
  // Sorted by shard then segment number — deterministic across reads. Cross-shard
  // ordering is otherwise irrelevant: readers re-sort events by timestamp.
  for (const shard of shardIds(author)) {
    out.push(...segmentsInShard(join(author.journalDir, shard)));
  }
  return out;
}

/** The segment file new entries should append to (in this machine's shard). */
function activeSegment(author: AuthorPaths): string {
  const shardDir = machineShardDir(author);
  const segments = segmentsInShard(shardDir);
  const file = segments[segments.length - 1];
  if (!file) return join(shardDir, '0001.log');
  // Roll to a fresh segment once the current one passes the size cap.
  if (statSync(file).size >= JOURNAL_SEGMENT_MAX_BYTES) {
    const n = Number(basename(file, '.log')) + 1;
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

// --- Hash chain -----------------------------------------------------------

/**
 * The hash a following entry's `prev` must equal: SHA-256 over the entry's
 * canonical JSON — the very bytes {@link appendJsonl} writes for it. Entries are
 * normalized first so a legacy line (no `v`) hashes the same for the writer and
 * for the verifier.
 */
export function entryHash(entry: JournalEntry | Record<string, unknown>): string {
  return sha256OfString(JSON.stringify(normalizeEntry(entry as Record<string, unknown>)));
}

/** The last non-empty line of a JSONL file, or null when it has none. */
function lastLineOf(file: string): string | null {
  if (!existsSync(file)) return null;
  const body = readFileSync(file, 'utf8').replace(/\s+$/, '');
  if (body.length === 0) return null;
  return body.slice(body.lastIndexOf('\n') + 1);
}

/**
 * The hash of the last entry already written in a machine shard — the value the
 * next appended entry's `prev` must carry. Walks segments backwards so the chain
 * carries across a rollover: when {@link activeSegment} hands back a brand-new
 * (or empty) segment, the tail of the previous one is used. Undefined for an
 * empty shard (the first entry of a chain is unanchored) or an unparseable tail
 * (a torn line must never block a capture — verify reports the break instead).
 */
function tailHash(shardDir: string): string | undefined {
  const segments = segmentsInShard(shardDir);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const line = lastLineOf(segments[i]!);
    if (line === null) continue; // Empty segment (e.g. just rolled) — look back.
    try {
      return entryHash(JSON.parse(line) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Re-link a run of entries into a valid hash chain: the first loses its `prev`,
 * every later one points at the canonical hash of the entry before it. Returns
 * new objects; the input is not mutated. Any rewrite that drops or edits lines
 * must run this, or every entry after the change would look tampered with.
 */
export function rechainEntries(entries: JournalEntry[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  let prev: string | undefined;
  for (const entry of entries) {
    const { prev: _dropped, ...rest } = entry;
    // `prev` last, exactly as `appendJournal` writes it, so the canonical bytes
    // of a re-chained entry match those of a freshly appended one.
    const next: JournalEntry = prev === undefined ? { ...rest } : { ...rest, prev };
    out.push(next);
    prev = entryHash(next);
  }
  return out;
}

/** One entry whose `prev` doesn't match the entry actually before it. */
export interface ChainBreak {
  /** 1-based position within the shard. */
  index: number;
  /** The id of the entry whose `prev` is wrong. */
  id: string;
  /** What `prev` should have been (undefined for the first entry of a shard). */
  expected: string | undefined;
  /** What it actually carried. */
  found: string | undefined;
}

/** The verdict for one shard's chain (see {@link checkChain}). */
export interface ChainCheck {
  /** Entries whose `prev` doesn't match — evidence of an edit or a deletion. */
  breaks: ChainBreak[];
  /** Entries carrying no `prev` at all: written before chaining existed. */
  unchained: number;
}

/**
 * Check one shard's hash chain. `entries` must be that shard's lines in write
 * order (see {@link readJournalShards}) — the chain is per shard by design.
 *
 * A missing `prev` is *not* a break: trails written by an older Showtail have
 * none, and they are reported as unchained (informational), never as tampering.
 * Note what this can and can't see: any edit, deletion, or insertion breaks the
 * *following* line's `prev` — including one that also strips its own `prev` to
 * pose as legacy. Only the last entry of a shard has no follower to disagree
 * with it, so editing or truncating the tail stays invisible here.
 */
export function checkChain(entries: JournalEntry[]): ChainCheck {
  const breaks: ChainBreak[] = [];
  let unchained = 0;
  let expected: string | undefined;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.prev === undefined) {
      // The first entry of a shard is legitimately unanchored; a later one with
      // no `prev` predates chaining.
      if (i > 0) unchained += 1;
    } else if (entry.prev !== expected) {
      breaks.push({ index: i + 1, id: entry.id, expected, found: entry.prev });
    }
    expected = entryHash(entry);
  }
  return { breaks, unchained };
}

// --- Reading / writing ----------------------------------------------------

/** One machine shard's entries, in write order — the unit the chain covers. */
export interface JournalShard {
  /** The machine id the shard directory is named after. */
  machineId: string;
  /** Every entry in the shard, oldest first (segments concatenated in order). */
  entries: JournalEntry[];
}

/** Append one journal entry to this author+machine's active segment. */
export function appendJournal(author: AuthorPaths, entry: JournalEntry): void {
  const shardDir = machineShardDir(author);
  const prev = tailHash(shardDir);
  const { prev: _dropped, ...rest } = entry;
  appendJsonl(activeSegment(author), prev === undefined ? rest : { ...rest, prev });
}

/**
 * Read one author's journal grouped by machine shard, each shard's entries in
 * write order. Callers that need to reason about the hash chain (only `verify`
 * today) must use this rather than {@link readJournal}, since the chain is
 * per shard and the flat read interleaves shards.
 */
export function readJournalShards(author: AuthorPaths): JournalShard[] {
  const out: JournalShard[] = [];
  for (const machineId of shardIds(author)) {
    const entries: JournalEntry[] = [];
    for (const seg of segmentsInShard(join(author.journalDir, machineId))) {
      for (const raw of readJsonl<Record<string, unknown>>(seg)) {
        entries.push(normalizeEntry(raw));
      }
    }
    out.push({ machineId, entries });
  }
  return out;
}

/**
 * Whether a journal line is a logged *event* — not a file snapshot and not a
 * `redaction` audit marker. The journal is a superset log, so every reader that
 * means "the student's prompts and replies" must go through this rather than
 * testing `kind !== 'artifact'`, which would sweep markers in too.
 */
export function isEventEntry(entry: JournalEntry): boolean {
  return entry.kind !== 'artifact' && entry.kind !== 'redaction';
}

/** Read every journal entry for one author across all segments, in write order. */
export function readJournal(author: AuthorPaths): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const seg of journalSegmentPaths(author)) {
    for (const raw of readJsonl<Record<string, unknown>>(seg)) {
      out.push(normalizeEntry(raw));
    }
  }
  return out;
}

/**
 * Rewrite one author's journal by mapping every entry through `edit`, and return
 * how many entries changed. The counterpart to {@link rewriteJournal}: that one
 * *drops* lines, this one *edits* them in place (the shape `showtail redact`
 * needs — repointing `refs` at rewritten objects, refreshing `textPreview`).
 *
 * `edit` must return the entry unchanged (the same object) when it has nothing
 * to do; identity is what decides whether a shard was touched. Touched shards
 * are re-chained across all of their segments, so an edit that was made on
 * purpose leaves an intact chain rather than looking like tampering — and one
 * that was not still breaks it at the next line.
 */
export function mapJournal(
  author: AuthorPaths,
  edit: (entry: JournalEntry) => JournalEntry,
): number {
  let changed = 0;
  for (const machineId of shardIds(author)) {
    const files = segmentsInShard(join(author.journalDir, machineId));
    const original = files.map((f) =>
      readJsonl<Record<string, unknown>>(f).map(normalizeEntry),
    );
    const edited = original.map((entries) => entries.map(edit));
    const touched = edited.reduce(
      (n, entries, i) => n + entries.filter((e, j) => e !== original[i]![j]).length,
      0,
    );
    if (touched === 0) continue; // Shard untouched — its chain is still valid.
    changed += touched;
    const rechained = rechainEntries(edited.flat());
    let at = 0;
    for (let i = 0; i < files.length; i += 1) {
      const slice = rechained.slice(at, at + edited[i]!.length);
      at += slice.length;
      writeJsonl(files[i]!, slice);
    }
  }
  return changed;
}

/**
 * Rewrite one author's journal, keeping only entries for which `keep` returns
 * true, and return how many were dropped. Used to remove a batch (e.g. `import
 * undo`). Rewrites affected shards only; objects are left for a future GC.
 *
 * Every touched shard is re-chained ({@link rechainEntries}) across all of its
 * segments, so a legitimate removal leaves an intact chain instead of looking
 * like tampering. Re-chaining spans segments because the chain does.
 *
 * A caller must also *declare* the rewrite by recording a marker (as
 * `removeEventsByBatch` does). An intact chain hides the rewrite from the chain
 * check, but not from git: the journal is append-only, so `verify` reads removed
 * lines in its history as a rewrite and reports every one nothing declares.
 * The same goes for {@link mapJournal}, which `showtail redact` pairs with its
 * own marker.
 */
export function rewriteJournal(
  author: AuthorPaths,
  keep: (entry: JournalEntry) => boolean,
): number {
  let removed = 0;
  for (const machineId of shardIds(author)) {
    const files = segmentsInShard(join(author.journalDir, machineId));
    const original = files.map((f) =>
      readJsonl<Record<string, unknown>>(f).map(normalizeEntry),
    );
    const kept = original.map((entries) => entries.filter(keep));
    const dropped = original.reduce((n, e, i) => n + (e.length - kept[i]!.length), 0);
    if (dropped === 0) continue; // Shard untouched — its chain is still valid.
    removed += dropped;
    const rechained = rechainEntries(kept.flat());
    let at = 0;
    for (let i = 0; i < files.length; i += 1) {
      const slice = rechained.slice(at, at + kept[i]!.length);
      at += slice.length;
      writeJsonl(files[i]!, slice);
    }
  }
  return removed;
}
