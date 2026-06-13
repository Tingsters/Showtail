import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Artifact, Config, Session, State } from '../types.ts';

export const SHOWTAIL_DIR = '.showtail';
export const CONFIG_VERSION = 1;

/**
 * A resolved view of a project's `.showtail/` layout. All paths are absolute.
 */
export interface ShowtailPaths {
  /** The directory that contains `.showtail/` (the project root). */
  root: string;
  /** The `.showtail/` directory itself. */
  base: string;
  config: string;
  state: string;
  sessionsDir: string;
  sessionsIndex: string;
  artifactsDir: string;
  artifactsIndex: string;
  reportsDir: string;
}

/** Error thrown when a command needs an initialized project but none is found. */
export class NotInitializedError extends Error {
  constructor() {
    super(
      'No .showtail/ folder found. Run `showtail init` first to start tracking your work.',
    );
    this.name = 'NotInitializedError';
  }
}

/** Build the set of `.showtail/` paths rooted at a given project directory. */
export function pathsForRoot(root: string): ShowtailPaths {
  const base = join(root, SHOWTAIL_DIR);
  return {
    root,
    base,
    config: join(base, 'config.json'),
    state: join(base, 'state.json'),
    sessionsDir: join(base, 'sessions'),
    sessionsIndex: join(base, 'sessions', 'index.json'),
    artifactsDir: join(base, 'artifacts'),
    artifactsIndex: join(base, 'artifacts', 'index.json'),
    reportsDir: join(base, 'reports'),
  };
}

/**
 * Walk up from `startDir` looking for an existing `.showtail/` folder.
 * Returns the project root (the folder containing `.showtail/`) or null.
 */
export function findRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  // Walk up until the filesystem root.
  while (true) {
    if (existsSync(join(dir, SHOWTAIL_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve `.showtail/` paths for the current project, walking up from `startDir`.
 * Throws {@link NotInitializedError} if no project is found.
 */
export function requirePaths(startDir: string = process.cwd()): ShowtailPaths {
  const root = findRoot(startDir);
  if (!root) throw new NotInitializedError();
  return pathsForRoot(root);
}

// --- JSON helpers ---------------------------------------------------------

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// --- JSONL helpers --------------------------------------------------------

/** Append one object as a single JSON line. */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

/** Overwrite a JSONL file with the given objects (one JSON line each). */
export function writeJsonl(file: string, values: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const body = values.map((v) => JSON.stringify(v)).join('\n');
  writeFileSync(file, body.length > 0 ? body + '\n' : '', 'utf8');
}

/** Read a JSONL file into objects. Empty/whitespace lines are skipped. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

// --- Typed accessors ------------------------------------------------------

export function readConfig(paths: ShowtailPaths): Config {
  return readJson<Config>(paths.config);
}

export function readState(paths: ShowtailPaths): State {
  if (!existsSync(paths.state)) return { currentSessionId: null };
  return readJson<State>(paths.state);
}

export function writeState(paths: ShowtailPaths, state: State): void {
  writeJson(paths.state, state);
}

export function readSessions(paths: ShowtailPaths): Session[] {
  if (!existsSync(paths.sessionsIndex)) return [];
  return readJson<Session[]>(paths.sessionsIndex);
}

export function writeSessions(paths: ShowtailPaths, sessions: Session[]): void {
  writeJson(paths.sessionsIndex, sessions);
}

export function readArtifacts(paths: ShowtailPaths): Artifact[] {
  if (!existsSync(paths.artifactsIndex)) return [];
  return readJson<Artifact[]>(paths.artifactsIndex);
}

export function writeArtifacts(paths: ShowtailPaths, artifacts: Artifact[]): void {
  writeJson(paths.artifactsIndex, artifacts);
}

/** Absolute path to a session's JSONL file. */
export function sessionFile(paths: ShowtailPaths, sessionId: string): string {
  return join(paths.sessionsDir, `${sessionId}.jsonl`);
}

/**
 * Normalize a user-provided file path to a clean, repo-relative, forward-slash
 * path so trails are consistent and portable across machines.
 */
export function toRepoRelative(root: string, filePath: string): string {
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  return rel.split(sep).join('/');
}
