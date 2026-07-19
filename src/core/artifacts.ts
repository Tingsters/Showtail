import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Artifact, JournalEntry, Tool } from '../types.ts';
import { extractEntities, supportsEntities } from './entities.ts';
import { maybeCurrentCommit } from './git.ts';
import { sha256OfFile } from './hash.ts';
import { makeId } from './ids.ts';
import { writeObject } from './objects.ts';
import { redact } from './redact.ts';
import {
  authorPaths,
  readConfig,
  toRepoRelative,
  type AuthorPaths,
  type ShowtailPaths,
} from './storage.ts';
import { JOURNAL_ENTRY_VERSION, appendJournal, readJournal } from './journal.ts';
import { authorSlugs } from './authors.ts';

/** Cap a single captured diff so one huge edit can't bloat the store. */
const MAX_DIFF_BYTES = 64 * 1024;

/** Skip entity extraction on very large files — a generated/vendored blob isn't
 * worth parsing and could stall capture. */
const MAX_ENTITY_BYTES = 2 * 1024 * 1024;

/**
 * The display path to record for an edited file. A file edited inside a git
 * worktree (`.claude/worktrees/<name>/…`) is recorded relative to that worktree
 * root, so the report shows the logical repo path (e.g. `src/core/report.ts`)
 * rather than the ephemeral worktree location. Everything else falls back to the
 * normal trail-root-relative path.
 */
const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/](.+)$/;
function reportRelativePath(root: string, abs: string): string {
  const m = abs.match(WORKTREE_RE);
  if (m) return m[1]!.split(/[\\/]/).join('/');
  return toRepoRelative(root, abs);
}

/** Options when recording an artifact. */
export interface AddArtifactInput {
  /** A path as the user typed it (absolute or relative to cwd). */
  filePath: string;
  sessionId?: string;
  /** Which tool the work flowed through when this snapshot was taken. */
  tool?: Tool;
  /** The prompt's turn this edit belongs to. */
  turnId?: string;
  /** AI-suggested code/diff that produced this snapshot, if captured. */
  diff?: string;
}

/** The result of recording an artifact. */
export interface AddArtifactResult {
  artifact: Artifact;
  /**
   * False when an identical snapshot already existed for this path (same hash
   * as the latest record) — nothing was written. This is what keeps a save
   * from being recorded twice when both the editor extension and the agent
   * try to snapshot the same unchanged file.
   */
  created: boolean;
}

/** Count the changed lines in a unified diff (else total lines of content). */
function countDiffLines(diff: string): number {
  const lines = diff.split('\n');
  const changed = lines.filter((l) => /^[+-](?![+-])/.test(l)).length;
  return changed > 0 ? changed : lines.filter((l) => l.length > 0).length;
}

/** Reconstruct an in-memory Artifact from its journal entry. */
export function artifactFromEntry(entry: JournalEntry): Artifact {
  const artifact: Artifact = {
    id: entry.id,
    path: entry.path ?? '',
    sha256: entry.sha256 ?? '',
    timestamp: entry.ts,
  };
  if (entry.linkPath) artifact.linkPath = entry.linkPath;
  if (entry.gitCommit) artifact.gitCommit = entry.gitCommit;
  if (entry.conv) artifact.sessionId = entry.conv;
  if (entry.actorSlug) artifact.actorSlug = entry.actorSlug;
  if (entry.tool) artifact.tool = entry.tool;
  if (entry.turn) artifact.turnId = entry.turn;
  if (entry.diffHash) artifact.diffHash = entry.diffHash;
  if (entry.diffLines !== undefined) artifact.diffLines = entry.diffLines;
  if (entry.entities) artifact.entities = entry.entities;
  return artifact;
}

/** Every recorded artifact for one author (file snapshots), oldest first. */
export function readArtifacts(author: AuthorPaths): Artifact[] {
  return readJournal(author)
    .filter((e) => e.kind === 'artifact')
    .map(artifactFromEntry);
}

/** Every recorded artifact across every author in the project, oldest first per author. */
export function readAllArtifacts(paths: ShowtailPaths): Artifact[] {
  const out: Artifact[] = [];
  for (const slug of authorSlugs(paths)) {
    for (const a of readArtifacts(authorPaths(paths, slug))) {
      // Attribute by the folder it came from when the entry didn't denormalize it.
      if (!a.actorSlug) a.actorSlug = slug;
      out.push(a);
    }
  }
  return out;
}

/**
 * Fill in entity data for artifacts that lack it, by re-reading the file from disk.
 * Entity extraction can silently produce nothing at capture time (e.g. it fails inside
 * a host tool's hook sandbox); this recovers it at report/trace time, where extraction
 * is reliable, so a reviewer still sees which functions/classes changed.
 *
 * Best-effort and exact: only an artifact whose file still exists at its recorded path
 * *and* still hashes to the recorded `sha256` is filled — i.e. we only attach entities to
 * a snapshot whose content we can prove is unchanged. Mutates the passed `Artifact`
 * objects in memory (never writes `.showtail/`, so a committed trail stays untouched) and
 * returns the same array. Artifacts with entities already, no hash, unsupported languages,
 * missing/changed files, or oversized content are left as-is.
 */
export async function recoverEntities(
  paths: ShowtailPaths,
  artifacts: Artifact[],
): Promise<Artifact[]> {
  for (const a of artifacts) {
    if (a.entities || !a.sha256 || !supportsEntities(a.path)) continue;
    const abs = resolve(paths.root, a.linkPath ?? a.path);
    if (!existsSync(abs)) continue;
    try {
      if ((await sha256OfFile(abs)) !== a.sha256) continue; // file changed since this snapshot
      const content = readFileSync(abs, 'utf8');
      if (Buffer.byteLength(content) > MAX_ENTITY_BYTES) continue;
      const entities = await extractEntities(content, a.path);
      if (entities) a.entities = entities;
    } catch {
      // Leave this artifact's entities unset on any read/parse failure.
    }
  }
  return artifacts;
}

/**
 * Record a snapshot (hash + metadata, and optionally the AI-suggested diff) of a
 * file into one author's trail. Artifacts build a hash history over time, but
 * recording the *same* content as the latest snapshot is a no-op (deduped) — so
 * repeated saves and double-captures don't pile up duplicates.
 */
export async function addArtifact(
  author: AuthorPaths,
  input: AddArtifactInput,
): Promise<AddArtifactResult> {
  const paths = author.shared;
  // Resolve the real on-disk file (absolute from the hook, or relative to the
  // trail root) separately from the display path — a worktree edit lives outside
  // the trail root, so we can't reconstruct it by re-joining root + repoPath.
  const absPath = resolve(paths.root, input.filePath);
  if (!existsSync(absPath)) {
    throw new Error(
      `File not found: ${input.filePath}. Pass a path to a file in your project.`,
    );
  }
  const repoPath = reportRelativePath(paths.root, absPath);
  // The path the report link resolves from: relative to the trail root, un-
  // stripped. For a worktree edit this differs from the (stripped) display path,
  // and is what lets `../../<linkPath>` actually reach the file from .showtail/.
  const linkPath = toRepoRelative(paths.root, absPath);

  const config = readConfig(paths);
  const sha256 = await sha256OfFile(absPath);

  // Dedupe: if the most recent snapshot of this path (in this author's trail) has
  // the same hash, the file hasn't changed since — don't record it again.
  const history = artifactsForPath(author, repoPath);
  const latest = history[history.length - 1];
  if (latest && latest.sha256 === sha256) {
    return { artifact: latest, created: false };
  }

  const gitCommit = await maybeCurrentCommit(paths.root, config.settings.git);

  const entry: JournalEntry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'artifact',
    id: makeId('art'),
    ts: new Date().toISOString(),
    type: 'artifact',
    conv: input.sessionId,
    actorSlug: author.slug,
    path: repoPath,
    sha256,
  };
  // Only record the link path when the display path was stripped (worktree edits).
  if (linkPath !== repoPath) entry.linkPath = linkPath;
  if (gitCommit) entry.gitCommit = gitCommit;
  if (input.tool) entry.tool = input.tool;
  if (input.turnId) entry.turn = input.turnId;

  // Capture the AI-suggested code into the (shared) object store (scrubbed, capped).
  if (input.diff && config.settings.captureCode !== false) {
    let diff = input.diff;
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
      diff = diff.slice(0, MAX_DIFF_BYTES) + '\n… (diff truncated)';
    }
    const { text: cleaned, hits } = redact(diff, config.settings.redact);
    entry.diffHash = writeObject(paths, cleaned);
    entry.diffLines = countDiffLines(cleaned);
    if (hits > 0) entry.redacted = hits;
  }

  // Record which named entities (functions, classes…) the file now contains, so
  // the report can show *what* changed, not just that the file did. Metadata
  // only — no source is stored — and fully best-effort: a parse failure or an
  // unsupported language just leaves `entities` unset.
  if (config.settings.captureEntities !== false && supportsEntities(absPath)) {
    try {
      const content = readFileSync(absPath, 'utf8');
      if (Buffer.byteLength(content) <= MAX_ENTITY_BYTES) {
        const entities = await extractEntities(content, repoPath);
        if (entities) entry.entities = entities;
      }
    } catch {
      // Never let entity capture break the snapshot.
    }
  }

  appendJournal(author, entry);
  return { artifact: artifactFromEntry(entry), created: true };
}

/** All artifact records for a given repo-relative path in one author's trail, oldest first. */
export function artifactsForPath(author: AuthorPaths, repoPath: string): Artifact[] {
  return readArtifacts(author).filter((a) => a.path === repoPath);
}

/** Options for back-filling a historical edit's diff as an artifact (see {@link importEditArtifact}). */
export interface ImportEditArtifactInput {
  /** Repo-relative display path of the edited file. */
  path: string;
  /** The AI-suggested diff/patch body that produced the edit. */
  diff: string;
  tool?: Tool;
  turnId?: string;
  /** Original edit time, so the snapshot back-dates into the trail. */
  timestamp?: string;
  sessionId?: string;
  /** Stable id so re-imports dedupe (see {@link importedArtifactSourceIds}). */
  sourceId?: string;
  /** Groups this with its import run so `import undo` removes it with the batch. */
  batchId?: string;
  /**
   * SHA-256 of the file at capture time. A projection from the ledger passes the
   * hash it captured live, so the projected snapshot keeps its integrity hash even
   * though this path never reads the file from disk.
   */
  sha256?: string;
  /** Git commit captured live, carried through a projection (see {@link sha256}). */
  gitCommit?: string;
}

/**
 * Source ids of every artifact already imported into this author's trail, for
 * idempotent re-import. (Events dedupe via {@link importedSourceIds}; artifacts
 * keep their own id on the journal entry, so they need their own scan.)
 */
export function importedArtifactSourceIds(author: AuthorPaths): Set<string> {
  const ids = new Set<string>();
  for (const e of readJournal(author)) {
    if (e.kind === 'artifact' && e.sourceId) ids.add(e.sourceId);
  }
  return ids;
}

/**
 * Record a *historical* edit (from an imported session) as a back-dated artifact
 * carrying its captured diff, so it renders as an expandable code change just like
 * a live snapshot. Unlike {@link addArtifact} this takes no file hash — a past
 * file's content can't be recovered — and never reads disk, so it works for
 * sessions whose files have since changed. The diff is scrubbed and capped the
 * same way live capture does. Returns false (no entry written) when capture is
 * off or the diff is empty.
 */
export function importEditArtifact(
  author: AuthorPaths,
  input: ImportEditArtifactInput,
): boolean {
  const paths = author.shared;
  const config = readConfig(paths);
  if (config.settings.captureCode === false || !input.diff) return false;

  let diff = input.diff;
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n… (diff truncated)';
  }
  const { text: cleaned, hits } = redact(diff, config.settings.redact);

  const entry: JournalEntry = {
    v: JOURNAL_ENTRY_VERSION,
    kind: 'artifact',
    id: makeId('art'),
    ts: input.timestamp ?? new Date().toISOString(),
    type: 'artifact',
    conv: input.sessionId,
    actorSlug: author.slug,
    path: input.path,
    diffHash: writeObject(paths, cleaned),
    diffLines: countDiffLines(cleaned),
  };
  // A live capture's hash/commit, carried through the projection (a plain import
  // has neither — it never saw the file on disk).
  if (input.sha256) entry.sha256 = input.sha256;
  if (input.gitCommit) entry.gitCommit = input.gitCommit;
  if (input.tool) entry.tool = input.tool;
  if (input.turnId) entry.turn = input.turnId;
  if (input.sourceId) entry.sourceId = input.sourceId;
  if (input.batchId) entry.batch = input.batchId;
  if (hits > 0) entry.redacted = hits;

  appendJournal(author, entry);
  return true;
}

/**
 * Check recorded artifacts against the files currently on disk, across every
 * author. For each path, the *latest* recorded hash (project-wide) is compared
 * to the live file.
 */
export interface HashCheck {
  path: string;
  expected: string;
  actual: string | null;
  status: 'match' | 'changed' | 'missing';
}

export async function checkArtifactHashes(paths: ShowtailPaths): Promise<HashCheck[]> {
  const artifacts = readAllArtifacts(paths);

  // Keep only the most recent record per path. Skip imported edits (no recorded
  // hash) — there's nothing to verify against, and they'd otherwise shadow a real
  // snapshot and report a spurious change.
  const latest = new Map<string, Artifact>();
  for (const a of artifacts) {
    if (!a.sha256) continue;
    const prev = latest.get(a.path);
    if (!prev || a.timestamp >= prev.timestamp) latest.set(a.path, a);
  }

  const checks: HashCheck[] = [];
  for (const [path, artifact] of latest) {
    const absPath = join(paths.root, path);
    if (!existsSync(absPath)) {
      checks.push({ path, expected: artifact.sha256, actual: null, status: 'missing' });
      continue;
    }
    const actual = await sha256OfFile(absPath);
    checks.push({
      path,
      expected: artifact.sha256,
      actual,
      status: actual === artifact.sha256 ? 'match' : 'changed',
    });
  }
  return checks;
}
