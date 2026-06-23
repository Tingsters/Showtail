import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, Session, State } from '../types.ts';
import { gitToplevel } from './git.ts';

export const SHOWTAIL_DIR = '.showtail';
/** Bumped to 3 for the per-author layout (one folder per student). */
export const CONFIG_VERSION = 3;

/**
 * A resolved view of a project's *shared* `.showtail/` layout. All paths are
 * absolute. These are the files every student in a repo shares (`config.json`),
 * the conflict-free content store (`objects/`), local-only runtime
 * (`state.json`, `reports/`), and the `authors/` directory under which each
 * student's own trail lives.
 *
 * Per-author paths (journal, sessions) are resolved separately via
 * {@link authorPaths} — partitioning every *writable* file per author is what
 * lets two students merge their trails through git without a conflict.
 */
export interface ShowtailPaths {
  /** The directory that contains `.showtail/` (the project root). */
  root: string;
  /** The `.showtail/` directory itself. */
  base: string;
  config: string;
  state: string;
  /** Parent of every per-author folder (`authors/<slug>/`). */
  authorsDir: string;
  /** Content-addressed object store (prompt/response text, code diffs). Shared. */
  objectsDir: string;
  /**
   * Saved, browsable plan files (`plans/<id>.md`). One copy per captured plan so
   * the report can link to it (the object store is content-addressed and not
   * meant to be opened directly). Shared, like `objects/`.
   */
  plansDir: string;
  reportsDir: string;
}

/**
 * A resolved view of one author's per-author trail under `authors/<slug>/`.
 * Carries a back-reference to the {@link ShowtailPaths} so a single value
 * threaded through the write path can reach both the author's own
 * journal/sessions and the shared object store / config / state.
 */
export interface AuthorPaths {
  /** The shared project paths this author belongs to. */
  shared: ShowtailPaths;
  /** The author's folder key (slugified email). */
  slug: string;
  /**
   * This machine's id, used to shard the journal so the *same* student writing
   * from two machines never collides on one segment file. Required to *append*;
   * omitted for read-only views built when aggregating across authors.
   */
  machineId?: string;
  /** `authors/<slug>/`. */
  dir: string;
  /** `authors/<slug>/author.json`. */
  authorFile: string;
  /** `authors/<slug>/sessions.json`. */
  sessionsIndex: string;
  /** `authors/<slug>/journal/` (segments live under `<machineId>/` subdirs). */
  journalDir: string;
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

/** Build the set of shared `.showtail/` paths rooted at a given project directory. */
export function pathsForRoot(root: string): ShowtailPaths {
  const base = join(root, SHOWTAIL_DIR);
  return {
    root,
    base,
    config: join(base, 'config.json'),
    state: join(base, 'state.json'),
    authorsDir: join(base, 'authors'),
    objectsDir: join(base, 'objects'),
    plansDir: join(base, 'plans'),
    reportsDir: join(base, 'reports'),
  };
}

/**
 * Build the per-author paths for one student under `authors/<slug>/`. Pass the
 * local `machineId` when this view will be used to *append* to the journal; it
 * may be omitted for read-only aggregation across authors.
 */
export function authorPaths(
  paths: ShowtailPaths,
  slug: string,
  machineId?: string,
): AuthorPaths {
  const dir = join(paths.authorsDir, slug);
  return {
    shared: paths,
    slug,
    machineId,
    dir,
    authorFile: join(dir, 'author.json'),
    sessionsIndex: join(dir, 'sessions.json'),
    journalDir: join(dir, 'journal'),
  };
}

/**
 * Walk up from `startDir` looking for an existing `.showtail/` folder.
 * Returns the project root (the folder containing `.showtail/`) or null.
 *
 * `SHOWTAIL_ROOT_CEILING` (when set) caps the upward walk at that directory:
 * a `.showtail/` *at* the ceiling is still found, but discovery never climbs
 * above it. This keeps spawned-CLI tests hermetic — their temp dirs live under
 * the OS temp dir, which itself sits under the user's home, so without a ceiling
 * `findRoot` would escape the sandbox and resolve a real `~/.showtail`. Unset in
 * normal use, so real users see the unchanged walk-to-filesystem-root behavior.
 */
export function findRoot(startDir: string = process.cwd()): string | null {
  const ceilingEnv = process.env.SHOWTAIL_ROOT_CEILING;
  const ceiling = ceilingEnv && ceilingEnv.length > 0 ? resolve(ceilingEnv) : null;
  let dir = resolve(startDir);
  // Walk up until the filesystem root (or the ceiling, if one is set).
  while (true) {
    if (existsSync(join(dir, SHOWTAIL_DIR))) return dir;
    if (ceiling && dir === ceiling) return null;
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

/**
 * The folder a new trail should be anchored at for work happening in `cwd`: the
 * git repo root when `cwd` is inside one, else `cwd` itself. This is the single
 * source of truth that keeps auto-init and {@link findRoot} in agreement — the
 * repo root is an ancestor of every subdir, so once `.showtail/` exists there
 * every subdir's `findRoot` resolves to it and no nested/duplicate trail is made.
 */
export async function resolveAnchor(cwd: string = process.cwd()): Promise<string> {
  const top = await gitToplevel(cwd);
  return top ? resolve(top) : resolve(cwd);
}

/** Files that mark a directory as a real development workspace. */
const DEV_MARKERS = [
  '.git',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'CMakeLists.txt',
  'Makefile',
];

/**
 * Whether `dir` is somewhere automatic tracking should create a trail: a real
 * project folder (git repo or one carrying a dev marker), and never the user's
 * HOME (which would turn every subfolder into one shared trail). Keeps silent
 * auto-init from littering `.showtail/` into arbitrary unrelated directories.
 */
export function isEligibleAnchor(dir: string): boolean {
  const resolved = resolve(dir);
  if (resolved === resolve(homedir())) return false;
  return DEV_MARKERS.some((marker) => existsSync(join(resolved, marker)));
}

// --- JSON helpers ---------------------------------------------------------

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  // Write to a per-process temp file then rename — an atomic replace on the same
  // volume — so a concurrent reader never sees a half-written file and two
  // writers can't interleave bytes into one document.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
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

/** Write the project config (atomic temp+rename, symmetric with {@link readConfig}). */
export function writeConfig(paths: ShowtailPaths, config: Config): void {
  writeJson(paths.config, config);
}

export function readState(paths: ShowtailPaths): State {
  if (!existsSync(paths.state)) return { currentSessionId: null };
  const state = readJson<State & { turnByClaudeSession?: Record<string, string> }>(
    paths.state,
  );
  // Back-compat: trails written before the tool-neutral rename carry
  // `turnByClaudeSession`. Surface it under the new name on read so old trails
  // keep working; only the new key is ever written.
  if (state.turnByClaudeSession && !state.turnByNativeSession) {
    state.turnByNativeSession = state.turnByClaudeSession;
    delete state.turnByClaudeSession;
  }
  return state;
}

export function writeState(paths: ShowtailPaths, state: State): void {
  writeJson(paths.state, state);
}

/** Merge a partial update into state without clobbering the other fields. */
export function updateState(paths: ShowtailPaths, partial: Partial<State>): void {
  writeState(paths, { ...readState(paths), ...partial });
}

/**
 * Record the open turn (prompt id) for a host tool's session id, so a later
 * edit from that same session attaches to the right prompt even when other
 * sessions are interleaved. Read-modify-write of the per-session map; tolerant
 * of a concurrent writer (worst case a live edit attributes to a slightly stale
 * turn — the Stop-hook transcript pass remains the authority for replies).
 */
export function setTurnForNativeSession(
  paths: ShowtailPaths,
  nativeSessionId: string,
  promptId: string,
): void {
  const state = readState(paths);
  const turnByNativeSession = {
    ...state.turnByNativeSession,
    [nativeSessionId]: promptId,
  };
  writeState(paths, { ...state, turnByNativeSession });
}

/** The open turn (prompt id) recorded for a host tool's session id, if any. */
export function turnForNativeSession(
  paths: ShowtailPaths,
  nativeSessionId: string,
): string | undefined {
  return readState(paths).turnByNativeSession?.[nativeSessionId];
}

// --- Sessions (per author) ------------------------------------------------

export function readSessions(author: AuthorPaths): Session[] {
  if (!existsSync(author.sessionsIndex)) return [];
  const sessions = readJson<Array<Session & { claudeSessionId?: string }>>(
    author.sessionsIndex,
  );
  // Back-compat: older trails stored the host session id as `claudeSessionId`.
  for (const s of sessions) {
    if (s.claudeSessionId && !s.nativeSessionId) {
      s.nativeSessionId = s.claudeSessionId;
      delete s.claudeSessionId;
    }
  }
  return sessions;
}

export function writeSessions(author: AuthorPaths, sessions: Session[]): void {
  writeJson(author.sessionsIndex, sessions);
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
