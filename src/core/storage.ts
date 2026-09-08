import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, Session, State } from '../types.ts';
import { makeId } from './ids.ts';

export const SHOWTAIL_DIR = '.showtail';

/** Files that identify a non-Git development workspace. */
const DEV_MARKERS = [
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
      'No .showtail/ folder found. Run `showtail track` first to start tracking your work.',
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
 * Find the existing `.showtail/` for the project containing `startDir`.
 * A broad ancestor trail cannot cross a nearer Git or development-workspace
 * boundary, and HOME is never treated as a project trail.
 *
 * `SHOWTAIL_ROOT_CEILING` (when set) caps the upward walk at that directory:
 * a `.showtail/` *at* the ceiling is still found, but discovery never climbs
 * above it. This keeps spawned-CLI tests hermetic — their temp dirs live under
 * the OS temp dir, which itself sits under the user's home, so without a ceiling
 * `findRoot` would escape the sandbox and resolve a real `~/.showtail`. Unset in
 * normal use, so real users see the unchanged walk-to-filesystem-root behavior.
 */
export function findRoot(startDir: string = process.cwd()): string | null {
  const root = projectAnchor(startDir);
  return root && existsSync(join(root, SHOWTAIL_DIR)) ? root : null;
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
 * The folder a new trail should be anchored at for work happening in `cwd`.
 * Reuses the same project-boundary rules as {@link findRoot}; when no project
 * evidence exists, callers receive `cwd` and decide whether it is eligible.
 */
export async function resolveAnchor(cwd: string = process.cwd()): Promise<string> {
  return projectAnchor(cwd) ?? resolve(cwd);
}

/**
 * Whether `dir` is somewhere automatic tracking should create a trail: a real
 * project folder (git repo or one carrying a dev marker), and never the user's
 * HOME (which would turn every subfolder into one shared trail). Keeps silent
 * auto-init from littering `.showtail/` into arbitrary unrelated directories.
 */
export function isEligibleAnchor(dir: string): boolean {
  const resolved = resolve(dir);
  const ceiling = rootCeiling();
  if (isHomedirCatchAll(resolved)) return false;
  if (!ceiling && isTempPath(resolved)) return false;
  return (
    existsSync(join(resolved, '.git')) ||
    DEV_MARKERS.some((marker) => existsSync(join(resolved, marker)))
  );
}

/**
 * Whether `dir` is the user's HOME — i.e. an existing `~/.showtail` is the
 * machine-wide catch-all, not a real project trail. Routing should never *place*
 * folderless work here (it belongs in the inbox). `track` and `ensure` also
 * refuse to create a trail here, so HOME can never become a project boundary.
 */
export function isHomedirCatchAll(dir: string): boolean {
  return existingPathKey(dir) === existingPathKey(homedir());
}

/** Resolve aliases such as macOS `/var` -> `/private/var` for existing paths. */
function existingPathKey(p: string): string {
  try {
    return pathKey(realpathSync.native(p));
  } catch {
    return pathKey(p);
  }
}

/**
 * A case-normalized key for a resolved path, so comparisons are correct on
 * Windows — where the ledger records drive-relative, lowercase-drive paths
 * (`c:\Users\…`) while `homedir()`/`cwd` yield `C:\Users\…`. Case-folds only on
 * win32; POSIX paths are already case-sensitive and left as-is.
 */
export function pathKey(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Whether `child` is `parent` or nested beneath it (case-insensitive on win32). */
export function isPathUnder(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Whether `dir` lives in a throwaway temp location (the OS temp dir, or a literal
 * `/tmp` / `\tmp`). Work in temp is scratch by default — a real case in the ledger
 * is a Maven project the AI scaffolded under `\tmp`. A pure path predicate; callers
 * decide when to apply it (see {@link eligibleProjectRoot}, which skips it under a
 * test ceiling so fixtures created in the OS temp dir aren't all treated as scratch).
 */
export function isTempPath(dir: string): boolean {
  return [tmpdir(), '/tmp', '\\tmp'].some((t) => isPathUnder(dir, t));
}

/**
 * The eligible project root enclosing `dir`, or null when `dir` is scratch.
 * Git roots outrank package markers so a monorepo stays one project. An explicit
 * nested trail may scope part of a Git repo; outside Git, a nearer package marker
 * outranks a broad ancestor trail. HOME and production temp paths never qualify.
 */
export function eligibleProjectRoot(dir: string): string | null {
  return projectAnchor(dir);
}

interface ProjectCandidates {
  ceiling: string | null;
  trail: string | null;
  git: string | null;
  marker: string | null;
}

/** Collect the nearest candidate of each kind without committing to a root yet. */
function projectCandidates(startDir: string): ProjectCandidates {
  const ceiling = rootCeiling();
  let trail: string | null = null;
  let git: string | null = null;
  let marker: string | null = null;
  let d = resolve(startDir);
  while (true) {
    if (!trail && existsSync(join(d, SHOWTAIL_DIR))) trail = d;
    if (!git && existsSync(join(d, '.git'))) git = d;
    if (!marker && DEV_MARKERS.some((name) => existsSync(join(d, name)))) marker = d;
    if (ceiling && pathKey(d) === pathKey(ceiling)) break;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return { ceiling, trail, git, marker };
}

/** Select the real project boundary from the candidates found on one path. */
function projectAnchor(startDir: string): string | null {
  const candidates = projectCandidates(startDir);
  const { ceiling } = candidates;
  const usable = (candidate: string | null): string | null => {
    if (!candidate || isHomedirCatchAll(candidate)) return null;
    if (!ceiling && isTempPath(candidate)) return null;
    return candidate;
  };
  const trail = usable(candidates.trail);
  const git = usable(candidates.git);
  const marker = usable(candidates.marker);
  let root: string | null;

  if (git) {
    // A trail inside the repository is an intentional nested scope. A trail above
    // the repository is a container/catch-all and must not absorb the repo.
    root = trail && isPathUnder(trail, git) ? trail : git;
  } else if (trail && marker) {
    // Both lie on the same ancestor chain; whichever is deeper is the actual
    // project boundary. Equality chooses the already-initialized trail.
    root = isPathUnder(trail, marker) ? trail : marker;
  } else {
    root = trail ?? marker;
  }

  return root;
}

function rootCeiling(): string | null {
  const value = process.env.SHOWTAIL_ROOT_CEILING;
  return value && value.length > 0 ? resolve(value) : null;
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
  // Keep `anchor` honest while we're here. It is informational only — `findRoot`
  // drives resolution — but a path frozen at init silently becomes wrong the moment
  // the student moves their project, and a stale absolute path left in the config is
  // a trap for the next reader (and for `status`/`ensure`, which surface it).
  const anchor = resolve(paths.root);
  const anchorStale =
    config.anchor !== undefined && pathKey(config.anchor) !== pathKey(anchor);
  if (config.trailId && !anchorStale) return config.trailId;
  const trailId = config.trailId ?? makeId('trl');
  config.trailId = trailId;
  if (anchorStale) config.anchor = anchor;
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
