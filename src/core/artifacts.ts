import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, JournalEntry, Tool } from '../types.ts';
import { maybeCurrentCommit } from './git.ts';
import { sha256OfFile } from './hash.ts';
import { makeId } from './ids.ts';
import { writeObject } from './objects.ts';
import { redact } from './redact.ts';
import {
  JOURNAL_ENTRY_VERSION,
  appendJournal,
  readConfig,
  readJournal,
  toRepoRelative,
  type ShowtailPaths,
} from './storage.ts';

/** Cap a single captured diff so one huge edit can't bloat the store. */
const MAX_DIFF_BYTES = 64 * 1024;

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
  if (entry.gitCommit) artifact.gitCommit = entry.gitCommit;
  if (entry.conv) artifact.sessionId = entry.conv;
  if (entry.tool) artifact.tool = entry.tool;
  if (entry.turn) artifact.turnId = entry.turn;
  if (entry.diffHash) artifact.diffHash = entry.diffHash;
  if (entry.diffLines !== undefined) artifact.diffLines = entry.diffLines;
  return artifact;
}

/** Every recorded artifact (file snapshot), oldest first. */
export function readArtifacts(paths: ShowtailPaths): Artifact[] {
  return readJournal(paths)
    .filter((e) => e.kind === 'artifact')
    .map(artifactFromEntry);
}

/**
 * Record a snapshot (hash + metadata, and optionally the AI-suggested diff) of a
 * file. Artifacts build a hash history over time, but recording the *same*
 * content as the latest snapshot is a no-op (deduped) — so repeated saves and
 * double-captures don't pile up duplicates.
 */
export async function addArtifact(
  paths: ShowtailPaths,
  input: AddArtifactInput,
): Promise<AddArtifactResult> {
  const repoPath = toRepoRelative(paths.root, input.filePath);
  const absPath = join(paths.root, repoPath);
  if (!existsSync(absPath)) {
    throw new Error(
      `File not found: ${input.filePath}. Pass a path to a file in your project.`,
    );
  }

  const config = readConfig(paths);
  const sha256 = await sha256OfFile(absPath);

  // Dedupe: if the most recent snapshot of this path has the same hash, the
  // file hasn't changed since — don't record it again.
  const history = artifactsForPath(paths, repoPath);
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
    path: repoPath,
    sha256,
  };
  if (gitCommit) entry.gitCommit = gitCommit;
  if (input.tool) entry.tool = input.tool;
  if (input.turnId) entry.turn = input.turnId;

  // Capture the AI-suggested code into the object store (scrubbed, capped).
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

  appendJournal(paths, entry);
  return { artifact: artifactFromEntry(entry), created: true };
}

/** All artifact records for a given repo-relative path, oldest first. */
export function artifactsForPath(paths: ShowtailPaths, repoPath: string): Artifact[] {
  return readArtifacts(paths).filter((a) => a.path === repoPath);
}

/**
 * Check recorded artifacts against the files currently on disk.
 * For each path, the *latest* recorded hash is compared to the live file.
 */
export interface HashCheck {
  path: string;
  expected: string;
  actual: string | null;
  status: 'match' | 'changed' | 'missing';
}

export async function checkArtifactHashes(paths: ShowtailPaths): Promise<HashCheck[]> {
  const artifacts = readArtifacts(paths);

  // Keep only the most recent record per path.
  const latest = new Map<string, Artifact>();
  for (const a of artifacts) {
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
