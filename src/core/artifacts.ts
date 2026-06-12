import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, Tool } from '../types.ts';
import { maybeCurrentCommit } from './git.ts';
import { sha256OfFile } from './hash.ts';
import { makeId } from './ids.ts';
import {
  readArtifacts,
  readConfig,
  toRepoRelative,
  writeArtifacts,
  type ShowtailPaths,
} from './storage.ts';

/** Options when recording an artifact. */
export interface AddArtifactInput {
  /** A path as the user typed it (absolute or relative to cwd). */
  filePath: string;
  sessionId?: string;
  eventIds?: string[];
  /** Which tool the work flowed through when this snapshot was taken. */
  tool?: Tool;
}

/**
 * Record a snapshot (hash + metadata) of a file. Artifacts are append-only:
 * recording the same path again adds a new record, building a hash history
 * over time rather than overwriting the previous one.
 */
export async function addArtifact(
  paths: ShowtailPaths,
  input: AddArtifactInput,
): Promise<Artifact> {
  const repoPath = toRepoRelative(paths.root, input.filePath);
  const absPath = join(paths.root, repoPath);
  if (!existsSync(absPath)) {
    throw new Error(
      `File not found: ${input.filePath}. Pass a path to a file in your project.`,
    );
  }

  const config = readConfig(paths);
  const sha256 = await sha256OfFile(absPath);
  const gitCommit = await maybeCurrentCommit(paths.root, config.settings.git);

  const artifact: Artifact = {
    id: makeId('art'),
    path: repoPath,
    sha256,
    timestamp: new Date().toISOString(),
  };
  if (gitCommit) artifact.gitCommit = gitCommit;
  if (input.sessionId) artifact.sessionId = input.sessionId;
  if (input.tool) artifact.tool = input.tool;
  if (input.eventIds && input.eventIds.length > 0) artifact.eventIds = input.eventIds;

  const all = readArtifacts(paths);
  all.push(artifact);
  writeArtifacts(paths, all);
  return artifact;
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
