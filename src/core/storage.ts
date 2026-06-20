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
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, JournalEntry, Session, State } from '../types.ts';

export const SHOWTAIL_DIR = '.showtail';
/** Bumped to 2 for the object-store + journal layout. */
export const CONFIG_VERSION = 2;

/** Roll to a new journal segment once the active one passes this size. */
const JOURNAL_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Current journal-entry schema version (see normalizeEntry). */
export const JOURNAL_ENTRY_VERSION = 1;

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
  /** Content-addressed object store (prompt/response text, code diffs). */
  objectsDir: string;
  /** Append-only journal segments (event + artifact metadata). */
  journalDir: string;
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
    objectsDir: join(base, 'objects'),
    journalDir: join(base, 'journal'),
    reportsDir: join(base, 'reports'),
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

export function readSessions(paths: ShowtailPaths): Session[] {
  if (!existsSync(paths.sessionsIndex)) return [];
  return readJson<Session[]>(paths.sessionsIndex);
}

export function writeSessions(paths: ShowtailPaths, sessions: Session[]): void {
  writeJson(paths.sessionsIndex, sessions);
}

// --- Journal (append-only metadata log) -----------------------------------

/** Journal segment file names, oldest first. */
function journalSegments(paths: ShowtailPaths): string[] {
  if (!existsSync(paths.journalDir)) return [];
  return readdirSync(paths.journalDir)
    .filter((f) => /^\d+\.log$/.test(f))
    .sort();
}

/** The segment new entries should append to (creating the first one if needed). */
function activeSegment(paths: ShowtailPaths): string {
  const segments = journalSegments(paths);
  const last = segments[segments.length - 1];
  if (!last) return '0001.log';
  const file = join(paths.journalDir, last);
  // Roll to a fresh segment once the current one passes the size cap.
  if (statSync(file).size >= JOURNAL_SEGMENT_MAX_BYTES) {
    const n = Number(last.replace('.log', '')) + 1;
    return `${String(n).padStart(4, '0')}.log`;
  }
  return last;
}

/** Bring an older/looser entry up to the current shape. Additive-only so far. */
export function normalizeEntry(raw: Record<string, unknown>): JournalEntry {
  const entry = raw as unknown as JournalEntry;
  return {
    ...entry,
    v: typeof raw.v === 'number' ? (raw.v as number) : JOURNAL_ENTRY_VERSION,
  };
}

/** Append one journal entry to the active segment (O(1), append-only). */
export function appendJournal(paths: ShowtailPaths, entry: JournalEntry): void {
  appendJsonl(join(paths.journalDir, activeSegment(paths)), entry);
}

/** Read every journal entry across all segments, in write order. */
export function readJournal(paths: ShowtailPaths): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const seg of journalSegments(paths)) {
    for (const raw of readJsonl<Record<string, unknown>>(join(paths.journalDir, seg))) {
      out.push(normalizeEntry(raw));
    }
  }
  return out;
}

/**
 * Rewrite the journal, keeping only entries for which `keep` returns true, and
 * return how many were dropped. Used to remove a batch (e.g. `import undo`).
 * Rewrites affected segments only; objects are left for a future GC.
 */
export function rewriteJournal(
  paths: ShowtailPaths,
  keep: (entry: JournalEntry) => boolean,
): number {
  let removed = 0;
  for (const seg of journalSegments(paths)) {
    const file = join(paths.journalDir, seg);
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
