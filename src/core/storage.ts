import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, JournalEntry, Session, State } from '../types.ts';
import { gitToplevel } from './git.ts';

export const SHOWTAIL_DIR = '.showtail';
/** Bumped to 3 for the per-author layout (one folder per student). */
export const CONFIG_VERSION = 3;

/** Roll to a new journal segment once the active one passes this size. */
const JOURNAL_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Current journal-entry schema version (see normalizeEntry). */
export const JOURNAL_ENTRY_VERSION = 1;

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
  return readJson<State>(paths.state);
}

export function writeState(paths: ShowtailPaths, state: State): void {
  writeJson(paths.state, state);
}

/** Merge a partial update into state without clobbering the other fields. */
export function updateState(paths: ShowtailPaths, partial: Partial<State>): void {
  writeState(paths, { ...readState(paths), ...partial });
}

/**
 * Record the open turn (prompt id) for a Claude Code `session_id`, so a later
 * edit from that same session attaches to the right prompt even when other
 * sessions are interleaved. Read-modify-write of the per-session map; tolerant
 * of a concurrent writer (worst case a live edit attributes to a slightly stale
 * turn — the Stop-hook transcript pass remains the authority for replies).
 */
export function setTurnForClaudeSession(
  paths: ShowtailPaths,
  claudeSessionId: string,
  promptId: string,
): void {
  const state = readState(paths);
  const turnByClaudeSession = {
    ...state.turnByClaudeSession,
    [claudeSessionId]: promptId,
  };
  writeState(paths, { ...state, turnByClaudeSession });
}

/** The open turn (prompt id) recorded for a Claude `session_id`, if any. */
export function turnForClaudeSession(
  paths: ShowtailPaths,
  claudeSessionId: string,
): string | undefined {
  return readState(paths).turnByClaudeSession?.[claudeSessionId];
}

// --- Sessions (per author) ------------------------------------------------

export function readSessions(author: AuthorPaths): Session[] {
  if (!existsSync(author.sessionsIndex)) return [];
  return readJson<Session[]>(author.sessionsIndex);
}

export function writeSessions(author: AuthorPaths, sessions: Session[]): void {
  writeJson(author.sessionsIndex, sessions);
}

// --- Journal (per author, append-only, machine-sharded) -------------------

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

/**
 * Normalize a user-provided file path to a clean, repo-relative, forward-slash
 * path so trails are consistent and portable across machines.
 */
export function toRepoRelative(root: string, filePath: string): string {
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  return rel.split(sep).join('/');
}
