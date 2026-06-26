import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, Session, State } from '../types.ts';
import { gitToplevel } from './git.ts';
import { makeId } from './ids.ts';

export const SHOWTAIL_DIR = '.showtail';
/**
 * Bumped to 4 for the stable `trailId` (the global ledger links sessions to a
 * trail by id, not by its movable path). Older trails are upgraded on read by
 * {@link ensureTrailId}.
 */
export const CONFIG_VERSION = 4;

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
  /** Legacy single sessions file `authors/<slug>/sessions.json` (read-only back-compat). */
  sessionsIndex: string;
  /** `authors/<slug>/sessions/` — per-machine session shards (`<machineId>.json`). */
  sessionsDir: string;
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
    sessionsDir: join(dir, 'sessions'),
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

/**
 * Whether `dir` is the user's HOME — i.e. an existing `~/.showtail` is the
 * machine-wide catch-all, not a real project trail. Routing should never *place*
 * folderless work here (it belongs in the inbox); only an explicit, deliberate
 * trail at HOME would be one, and we don't auto-create those (see
 * {@link isEligibleAnchor}).
 */
export function isHomedirCatchAll(dir: string): boolean {
  return resolve(dir) === resolve(homedir());
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

/**
 * Return this trail's stable id, minting and persisting one on a trail that
 * predates trail ids (upgrade-on-read). Also bumps the stored config version so
 * the upgrade happens once. Idempotent: a trail that already has a `trailId`
 * keeps it and no write occurs. The write is atomic (temp+rename) and tolerant
 * of a concurrent writer — both would mint, and the last write wins; the loser's
 * id simply isn't the one recorded, which the ledger reconciles on next sight.
 */
export function ensureTrailId(paths: ShowtailPaths): string {
  const config = readConfig(paths);
  if (config.trailId) return config.trailId;
  const trailId = makeId('trl');
  config.trailId = trailId;
  if (config.version < CONFIG_VERSION) config.version = CONFIG_VERSION;
  writeConfig(paths, config);
  return trailId;
}

/**
 * Whether this trail was written by a *newer* Showtail than the running binary
 * (its `config.version` exceeds {@link CONFIG_VERSION}). Used to warn that some
 * data — e.g. sessions written in a layout this binary doesn't know — may not be
 * visible, so the user knows to upgrade. Tolerant of a missing/corrupt config.
 */
export function trailIsNewerThanBinary(paths: ShowtailPaths): boolean {
  try {
    return readConfig(paths).version > CONFIG_VERSION;
  } catch {
    return false;
  }
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

/**
 * Read every session for one author, aggregating the union of the legacy single
 * `sessions.json` (if present) and every per-machine shard under `sessions/`.
 * Sharding by machine is what lets the same student writing from two machines
 * merge through git without a conflict (the journal uses the same trick). A shard
 * entry wins over a legacy entry of the same id (legacy is processed first).
 */
export function readSessions(author: AuthorPaths): Session[] {
  const files: string[] = [];
  if (existsSync(author.sessionsIndex)) files.push(author.sessionsIndex);
  if (existsSync(author.sessionsDir)) {
    for (const f of readdirSync(author.sessionsDir).sort()) {
      if (f.endsWith('.json')) files.push(join(author.sessionsDir, f));
    }
  }
  const byId = new Map<string, Session>();
  for (const file of files) {
    let rows: Array<Session & { claudeSessionId?: string }>;
    try {
      rows = readJson(file);
    } catch {
      continue; // A torn/partial shard must never break a read.
    }
    for (const s of rows) {
      // Back-compat: older trails stored the host session id as `claudeSessionId`.
      if (s.claudeSessionId && !s.nativeSessionId) {
        s.nativeSessionId = s.claudeSessionId;
        delete s.claudeSessionId;
      }
      byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

/**
 * Persist this author's sessions for THIS machine only, into the per-machine
 * shard `sessions/<machineId>.json`. Callers pass the full read union; rows owned
 * by other machines (or legacy rows with no `machineId`) are filtered out and
 * left to their own file, so two machines never clobber each other on merge.
 * Requires `machineId` — like the journal, you can't write without knowing the
 * shard.
 */
export function writeSessions(author: AuthorPaths, sessions: Session[]): void {
  if (!author.machineId) {
    throw new Error('Cannot write sessions without a machineId.');
  }
  const mine = sessions.filter((s) => s.machineId === author.machineId);
  writeJson(join(author.sessionsDir, `${author.machineId}.json`), mine);
}

/**
 * Migrate a legacy single `sessions.json` into THIS machine's shard, so the old
 * sessions carry a `machineId` and can be closed/swept (a write-path no-op once
 * done — the legacy file is deleted). Idempotent and best-effort.
 *
 * Only runs when this machine is the trail's *sole* contributor (no other machine
 * has a journal shard): in a git-merged multi-machine repo the legacy file may hold
 * another machine's sessions, and claiming them would mis-attribute them — there we
 * leave it read-only (it still merges into reports via {@link readSessions}).
 */
export function migrateLegacySessions(author: AuthorPaths): void {
  if (!author.machineId || !existsSync(author.sessionsIndex)) return;
  // Sole-contributor gate: bail if another machine has a journal shard.
  if (existsSync(author.journalDir)) {
    const others = readdirSync(author.journalDir).filter((m) => m !== author.machineId);
    if (others.length > 0) return;
  }
  let legacy: Array<Session & { claudeSessionId?: string }>;
  try {
    legacy = readJson(author.sessionsIndex);
  } catch {
    return; // Corrupt legacy file — leave it for a human, never crash a write.
  }
  const shardFile = join(author.sessionsDir, `${author.machineId}.json`);
  const byId = new Map<string, Session>();
  if (existsSync(shardFile)) {
    try {
      for (const s of readJson<Session[]>(shardFile)) byId.set(s.id, s);
    } catch {
      /* ignore a torn shard; the legacy rows below still seed it */
    }
  }
  for (const s of legacy) {
    if (s.claudeSessionId && !s.nativeSessionId) {
      s.nativeSessionId = s.claudeSessionId;
      delete s.claudeSessionId;
    }
    if (!byId.has(s.id)) byId.set(s.id, { ...s, machineId: author.machineId });
  }
  writeJson(shardFile, [...byId.values()]);
  rmSync(author.sessionsIndex, { force: true });
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
