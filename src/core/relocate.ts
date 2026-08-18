/**
 * Content-lineage relocation matching — re-associating captured work with its
 * files after a student moves them.
 *
 * Why this exists: the ledger stores edit paths ABSOLUTE (see the note in
 * `ledger.ts`) and lives outside any repo, so it does not travel when a student
 * moves or renames their project folder — or when they ask the AI to move it. The
 * trail *format* is already move-proof (repo-relative journal paths, a
 * content-addressed object store), so nothing is lost; but every path-based lookup
 * stops matching, and the work silently stops surfacing.
 *
 * Filenames are deliberately NOT evidence here. Students have many identically
 * named files (`main.py`, `index.js`, `app.py`), so matching on a basename would
 * happily attribute one project's work to another — the worst possible failure for
 * a provenance tool. What we do have is the captured content itself:
 * {@link LedgerRecord.diff} holds the change body (for a `Write`, the entire file),
 * alongside a `sha256` and `gitCommit` per edit.
 *
 * Confidence tiers:
 *   A — deterministic. Git-commit containment, or an exact `sha256` hit. Proven;
 *       safe to associate without asking.
 *   B — content-based. A distinctive captured block found verbatim in a candidate
 *       file, or high shingle *containment*. Strong, but offered for confirmation
 *       rather than applied silently.
 *   C — names and directory shape. Never evidence. Used only to ORDER candidates
 *       so the decisive files are examined first.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { commitExists } from './git.ts';
import { sha256OfFile } from './hash.ts';
import {
  allLedgerSessions,
  readLedgerRecords,
  type LedgerRecord,
  type LedgerSession,
} from './ledger.ts';
import { pathKey } from './storage.ts';

/** How confident a relocation match is. See the module note. */
export type MatchTier = 'A' | 'B';

/** An old-root → new-root mapping, so projected paths re-relativize cleanly. */
export interface PathRebase {
  fromRoot: string;
  toRoot: string;
}

/** A candidate location for a session's moved work, with the evidence for it. */
export interface RelocationMatch {
  /** The folder the caller asked about. */
  root: string;
  tier: MatchTier;
  /** Short human-readable justification, shown in CLI output. */
  detail: string;
  /** Within-tier strength (0..1), for ranking. */
  score: number;
  /** Derived from the matched file pair; lets `materialize` rebase stale paths. */
  rebase?: PathRebase;
}

export interface RelocationOptions {
  /** Cap on candidate files examined (protects against huge trees). */
  maxFiles?: number;
  /** Skip files larger than this (bytes) — diffs are capped at 64 KB anyway. */
  maxFileBytes?: number;
  /** Minimum shingle containment for a Tier-B match. */
  minContainment?: number;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MIN_CONTAINMENT = 0.6;

/** Shingle width in lines. 3 is long enough to be distinctive, short enough to survive edits. */
const SHINGLE_LINES = 3;
/** Below this many shingles the captured evidence is too thin to trust a similarity score. */
const MIN_SHINGLES = 3;
/** A captured line must be at least this long (trimmed) to count as distinctive. */
const MIN_DISTINCTIVE_CHARS = 24;
/** A verbatim-containment fragment must be at least this many distinctive lines. */
const MIN_FRAGMENT_LINES = 3;
/** Only probe a handful of commits — one hit is proof, and each costs a git call. */
const MAX_COMMIT_PROBES = 5;

/** Directories never worth walking when looking for a student's moved files. */
const SKIP_DIRS = new Set([
  '.git',
  '.showtail',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '.mypy_cache',
]);

// --- evidence -------------------------------------------------------------

/** What one captured edit tells us about the file it touched. */
interface EditEvidence {
  /** Absolute path as recorded at capture time (now possibly stale). */
  file: string;
  sha256?: string;
  /** The `+` side of the captured diff, de-prefixed. */
  addedLines: string[];
}

/**
 * Pull the added (`+`) lines out of a captured diff. Handles both Showtail's own
 * `'+ '`-prefixed form (see `simpleDiff` in `hookInput.ts`) and a verbatim unified
 * patch (Codex `apply_patch`), while skipping `+++` file headers.
 */
function addedLinesOf(diff: string): string[] {
  const out: string[] = [];
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++') || !raw.startsWith('+')) continue;
    out.push(raw.startsWith('+ ') ? raw.slice(2) : raw.slice(1));
  }
  return out;
}

/** A line distinctive enough that finding it verbatim elsewhere means something. */
function isDistinctive(line: string): boolean {
  const t = line.trim();
  return t.length >= MIN_DISTINCTIVE_CHARS && /[A-Za-z]/.test(t);
}

/** Normalize line endings so CRLF-on-disk still matches LF-in-the-ledger. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** The per-edit evidence a session carries, newest-last, edits only. */
function editEvidenceOf(records: LedgerRecord[]): EditEvidence[] {
  const out: EditEvidence[] = [];
  for (const rec of records) {
    if (rec.kind !== 'edit' || !rec.file) continue;
    out.push({
      file: rec.file,
      sha256: rec.sha256,
      addedLines: rec.diff ? addedLinesOf(rec.diff) : [],
    });
  }
  return out;
}

/** Distinct captured commits, most recent first, capped (one hit is proof). */
function commitsOf(records: LedgerRecord[]): string[] {
  const seen = new Set<string>();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const sha = records[i]?.gitCommit;
    if (sha) seen.add(sha);
    if (seen.size >= MAX_COMMIT_PROBES) break;
  }
  return [...seen];
}

/**
 * Every sha256 the ledger has recorded, keyed by the path it was recorded for.
 *
 * A student who kept working at the old location across several sessions built up
 * a hash history there, and any one of those hashes still identifies the file
 * after it moves — which widens the exact-match net well beyond one session's own
 * snapshot.
 *
 * Built ONCE per sweep and cached on the candidate index, because it costs a full
 * pass over every session's records: `showtail track` tests many sessions against
 * one folder, so building it per session re-parsed the entire ledger each time
 * (measured on a real machine: 118 sessions, ~2.9k records, 3.6 MB). Session-
 * independent by design — callers subtract their own hashes — which is precisely
 * what makes it safe to share.
 */
function ledgerHashIndex(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of allLedgerSessions()) {
    for (const rec of readLedgerRecords(s.id)) {
      if (rec.kind !== 'edit' || !rec.file || !rec.sha256) continue;
      const key = pathKey(rec.file);
      const set = out.get(key);
      if (set) set.add(rec.sha256);
      else out.set(key, new Set([rec.sha256]));
    }
  }
  return out;
}

// --- candidate walk -------------------------------------------------------

interface Candidate {
  abs: string;
  size: number;
}

/**
 * A folder's files plus memoized hashes/contents, so matching many sessions against
 * one folder walks and hashes it once. `showtail track` does exactly that, and
 * without sharing it would re-hash the whole tree per session.
 */
export interface CandidateIndex {
  root: string;
  candidates: Candidate[];
  maxFileBytes: number;
  /** abs → sha256, filled on demand. */
  hashes: Map<string, string>;
  /** abs → text (null when binary/unreadable), filled on demand. */
  texts: Map<string, string | null>;
  /** Ledger-wide `path → hashes`, built at most once per sweep. */
  ledgerHashes?: Map<string, Set<string>>;
}

/** Walk `root` once and return a reusable index for {@link matchSessionToRoot}. */
export function prepareCandidateIndex(
  root: string,
  opts: RelocationOptions = {},
): CandidateIndex {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return {
    root: resolve(root),
    candidates: walkCandidates(root, maxFiles, maxFileBytes),
    maxFileBytes,
    hashes: new Map(),
    texts: new Map(),
  };
}

/** Bounded, ignore-aware walk of a candidate folder. Never leaves `root`. */
function walkCandidates(
  root: string,
  maxFiles: number,
  maxFileBytes: number,
): Candidate[] {
  const out: Candidate[] = [];
  const stack: string[] = [resolve(root)];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // unreadable dir — skip quietly, like the transcript readers do
    }
    for (const name of names) {
      if (out.length >= maxFiles) break;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(abs);
      } else if (st.isFile() && st.size > 0 && st.size <= maxFileBytes) {
        out.push({ abs, size: st.size });
      }
    }
  }
  return out;
}

/** Read a candidate as text, or null when it's binary/unreadable/too big. */
function readTextFile(abs: string, maxBytes: number): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.byteLength > maxBytes || buf.includes(0)) return null;
    return normalizeEol(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Order candidates so the decisive ones are examined first: same basename as a
 * captured path, then anything else. This is Tier C — ordering ONLY. Every
 * candidate still gets examined, so a file that was renamed as well as moved is
 * still found; the name just doesn't get a vote.
 */
function orderCandidates(candidates: Candidate[], evidence: EditEvidence[]): Candidate[] {
  const wanted = new Set(evidence.map((e) => basename(e.file).toLowerCase()));
  const first: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of candidates) {
    if (wanted.has(basename(c.abs).toLowerCase())) first.push(c);
    else rest.push(c);
  }
  return [...first, ...rest];
}

// --- similarity -----------------------------------------------------------

/** k-line shingles over non-blank, trimmed lines. */
function shinglesOf(lines: string[]): Set<string> {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_LINES <= cleaned.length; i += 1) {
    out.add(cleaned.slice(i, i + SHINGLE_LINES).join('\n'));
  }
  return out;
}

/**
 * Fraction of the *captured* shingles present in the candidate — containment, not
 * Jaccard. This is the right metric here: a small `Edit` contributes only a few
 * lines, so Jaccard against a whole file would score near zero even for the
 * correct file, while containment correctly asks "is what we captured in here?".
 */
function containment(captured: Set<string>, candidate: Set<string>): number {
  if (captured.size === 0) return 0;
  let hits = 0;
  for (const s of captured) if (candidate.has(s)) hits += 1;
  return hits / captured.size;
}

/**
 * The longest run of consecutive distinctive captured lines, as a verbatim block.
 * Finding this exact block in a candidate is near-conclusive: unrelated files do
 * not share a multi-line span of substantive code.
 */
function longestDistinctiveBlock(addedLines: string[]): string | null {
  let best: string[] = [];
  let run: string[] = [];
  for (const line of addedLines) {
    if (isDistinctive(line)) {
      run.push(line);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  return best.length >= MIN_FRAGMENT_LINES ? best.join('\n') : null;
}

// --- rebase ---------------------------------------------------------------

/**
 * Derive an old-root → new-root mapping from a matched file pair by stripping the
 * shared trailing segments. `…\bin\game\main.py` matched against
 * `…\Documents\game\main.py` yields `…\bin` → `…\Documents`, which is what lets a
 * projection re-relativize the *other* records in the same session instead of
 * rendering them as `../../..` paths.
 */
export function deriveRebase(oldAbs: string, newAbs: string): PathRebase | undefined {
  const a = resolve(oldAbs).split(sep);
  const b = resolve(newAbs).split(sep);
  let shared = 0;
  while (
    shared < a.length - 1 &&
    shared < b.length - 1 &&
    pathKey(a[a.length - 1 - shared] ?? '') === pathKey(b[b.length - 1 - shared] ?? '')
  ) {
    shared += 1;
  }
  if (shared === 0) return undefined;
  return {
    fromRoot: a.slice(0, a.length - shared).join(sep),
    toRoot: b.slice(0, b.length - shared).join(sep),
  };
}

/**
 * Derive a rebase for an already-proven match by locating one of the session's
 * recorded files under `root` on disk.
 *
 * Needed because a Tier A git-commit match proves the folder without ever pairing
 * a file — and the projection still needs an old-root → new-root mapping, or every
 * relocated path renders as a `../../..` escape from the new root. That is the
 * commonest relocation of all (a moved repo with its history intact), so without
 * this the strongest evidence produced the worst paths.
 *
 * This probes `existsSync` on progressively shorter trailing segments of the
 * recorded path (`game/main.py`, then `main.py`) — a filesystem lookup, not a
 * name-similarity vote. Whether the session belongs here is already settled by
 * other evidence; this only computes the path translation, so it does not weaken
 * the rule that names are never evidence. Longest suffix wins, being the least
 * ambiguous.
 */
export function deriveRebaseAgainstRoot(
  editPaths: string[],
  root: string,
): PathRebase | undefined {
  const base = resolve(root);
  for (const p of editPaths) {
    const segs = resolve(p).split(sep);
    for (let take = segs.length - 1; take >= 1; take -= 1) {
      const candidate = join(base, ...segs.slice(segs.length - take));
      if (existsSync(candidate)) {
        const rebase = deriveRebase(p, candidate);
        if (rebase) return rebase;
      }
    }
  }
  return undefined;
}

/**
 * Re-point a stale absolute path through a rebase, or return undefined when the
 * path doesn't sit under the mapping's old root.
 */
export function applyRebase(rebase: PathRebase, oldAbs: string): string | undefined {
  const from = pathKey(rebase.fromRoot);
  const target = pathKey(oldAbs);
  if (target === from) return rebase.toRoot;
  if (!target.startsWith(from + sep)) return undefined;
  return join(rebase.toRoot, resolve(oldAbs).slice(rebase.fromRoot.length + 1));
}

// --- matching -------------------------------------------------------------

/**
 * Whether `session`'s captured work appears to live under `root` now, and on what
 * evidence. Returns the strongest match found, or null.
 *
 * Tier A is proof (a captured commit present in the folder's history, or a byte-
 * exact hash hit) and callers may act on it directly. Tier B is strong evidence
 * that should be confirmed by a human before it changes attribution.
 */
export async function matchSessionToRoot(
  session: LedgerSession,
  root: string,
  opts: RelocationOptions = {},
  index?: CandidateIndex,
): Promise<RelocationMatch | null> {
  const minContainment = opts.minContainment ?? DEFAULT_MIN_CONTAINMENT;
  const idx = index ?? prepareCandidateIndex(root, opts);
  const maxFileBytes = idx.maxFileBytes;

  const records = readLedgerRecords(session.id);
  const evidence = editEvidenceOf(records);

  // --- Tier A.1: git-commit containment. Cheapest and strongest; needs no walk.
  // It proves the folder without pairing a file, so the rebase is derived by
  // locating a recorded file under the root (see `deriveRebaseAgainstRoot`).
  for (const sha of commitsOf(records)) {
    if (await commitExists(root, sha)) {
      return {
        root,
        tier: 'A',
        score: 1,
        detail: `captured commit ${sha.slice(0, 8)} is in this folder's history`,
        rebase: deriveRebaseAgainstRoot(
          evidence.map((e) => e.file),
          root,
        ),
      };
    }
  }

  if (evidence.length === 0) return null; // no per-file evidence to match on

  const candidates = orderCandidates(idx.candidates, evidence);
  if (candidates.length === 0) return null;

  // --- Tier A.2: exact sha256, against this session's hashes then the wider
  // cross-session history for the same paths. Candidate hashes are cached so the
  // second pass costs nothing extra.
  const ownHashes = new Set(
    evidence.map((e) => e.sha256).filter((h): h is string => h !== undefined),
  );
  const hashHit = async (expected: Set<string>): Promise<Candidate | null> => {
    if (expected.size === 0) return null;
    for (const c of candidates) {
      let h = idx.hashes.get(c.abs);
      if (h === undefined) {
        try {
          h = await sha256OfFile(c.abs);
        } catch {
          continue;
        }
        idx.hashes.set(c.abs, h);
      }
      if (expected.has(h)) return c;
    }
    return null;
  };

  const own = await hashHit(ownHashes);
  if (own) return exactMatch(root, evidence, own, ownHashes, 'content hash');

  // Widen to hashes any session ever recorded for these same paths, minus the ones
  // we just tried. The ledger-wide index is built at most once and shared.
  idx.ledgerHashes ??= ledgerHashIndex();
  const historical = new Set<string>();
  for (const e of evidence) {
    const seen = idx.ledgerHashes.get(pathKey(e.file));
    if (seen) for (const h of seen) historical.add(h);
  }
  for (const h of ownHashes) historical.delete(h);
  const past = await hashHit(historical);
  if (past) {
    return exactMatch(root, evidence, past, historical, 'earlier content hash');
  }

  // --- Tier B: content, name-independent.
  let best: RelocationMatch | null = null;
  const prepared = evidence
    .map((e) => ({
      e,
      block: longestDistinctiveBlock(e.addedLines),
      shingles: shinglesOf(e.addedLines),
    }))
    .filter((p) => p.block !== null || p.shingles.size >= MIN_SHINGLES);
  if (prepared.length === 0) return null;

  for (const c of candidates) {
    let text = idx.texts.get(c.abs);
    if (text === undefined) {
      text = readTextFile(c.abs, maxFileBytes);
      idx.texts.set(c.abs, text);
    }
    if (text === null) continue;
    const candidateShingles = shinglesOf(text.split('\n'));
    for (const p of prepared) {
      if (p.block !== null && text.includes(p.block)) {
        // Verbatim multi-line block — as good as Tier B gets; stop looking.
        return {
          root,
          tier: 'B',
          score: 0.95,
          detail: `a distinctive ${p.block.split('\n').length}-line captured block appears verbatim in ${basename(c.abs)}`,
          rebase:
            deriveRebase(p.e.file, c.abs) ??
            deriveRebaseAgainstRoot(
              evidence.map((e) => e.file),
              root,
            ),
        };
      }
      if (p.shingles.size < MIN_SHINGLES) continue;
      const score = containment(p.shingles, candidateShingles);
      if (score >= minContainment && (best === null || score > best.score)) {
        best = {
          root,
          tier: 'B',
          score,
          detail: `${Math.round(score * 100)}% of captured content still present in ${basename(c.abs)}`,
          rebase:
            deriveRebase(p.e.file, c.abs) ??
            deriveRebaseAgainstRoot(
              evidence.map((e) => e.file),
              root,
            ),
        };
      }
    }
  }
  return best;
}

/** Build the Tier-A result for a hash hit, attributing it to the right old path. */
function exactMatch(
  root: string,
  evidence: EditEvidence[],
  hit: Candidate,
  expected: Set<string>,
  label: string,
): RelocationMatch {
  // Prefer the evidence entry that actually carries the matching hash; fall back to
  // same-basename, then the first, so the rebase is derived from the closest pair.
  const byHash = evidence.find((e) => e.sha256 !== undefined && expected.has(e.sha256));
  const byName = evidence.find(
    (e) => basename(e.file).toLowerCase() === basename(hit.abs).toLowerCase(),
  );
  const source = byHash ?? byName ?? evidence[0];
  const paired = source ? deriveRebase(source.file, hit.abs) : undefined;
  return {
    root,
    tier: 'A',
    score: 1,
    detail: `${label} of ${basename(hit.abs)} matches captured work exactly`,
    // A renamed-as-well-as-moved file shares no trailing segments, so fall back to
    // locating any other recorded file under the root.
    rebase:
      paired ??
      deriveRebaseAgainstRoot(
        evidence.map((e) => e.file),
        root,
      ),
  };
}
