import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Config, Session, State } from '../types.ts';
import { requireCaptureContinuation } from './captureGuard.ts';
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
 * Bumped to 5 for project-evidence and initialization provenance. The new
 * fields are optional, so older trails remain readable and upgrade lazily.
 */
export const CONFIG_VERSION = 5;

export type ProjectEvidence =
  | 'trail'
  | 'git'
  | 'marker'
  | 'workspace'
  | 'edit'
  | 'tool'
  | 'attachment'
  | 'control'
  | 'cwd'
  | 'explicit';

export type ProjectContext =
  | {
      state: 'tracked' | 'candidate';
      root: string;
      evidence: ProjectEvidence;
    }
  | {
      state: 'ambiguous';
      root: null;
      evidence: null;
      candidates: string[];
    }
  | {
      state: 'none';
      root: null;
      evidence: null;
      candidates: [];
    };

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
  constructor(message = 'No Showtail project trail exists for this folder yet.') {
    super(message);
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
 * boundary. A HOME trail is local to HOME itself and never absorbs descendants.
 *
 * `SHOWTAIL_ROOT_CEILING` (when set) caps the upward walk at that directory:
 * a `.showtail/` *at* the ceiling is still found, but discovery never climbs
 * above it. This keeps spawned-CLI tests hermetic — their temp dirs live under
 * the OS temp dir, which itself sits under the user's home, so without a ceiling
 * `findRoot` would escape the sandbox and resolve a real `~/.showtail`. Unset in
 * normal use, so real users see the unchanged walk-to-filesystem-root behavior.
 */
export function findRoot(startDir: string = process.cwd()): string | null {
  const boundary = projectBoundary(startDir);
  return boundary && existsSync(join(boundary.root, SHOWTAIL_DIR)) ? boundary.root : null;
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
  return projectBoundary(cwd)?.root ?? resolve(cwd);
}

/**
 * Whether `dir` can hold a project trail. Creation is triggered only by a real
 * prompt (or an explicit command), so path-name heuristics do not decide whether
 * a student's folder is legitimate. The actual mkdir/write remains the final
 * writability check.
 */
export function isEligibleAnchor(dir: string): boolean {
  try {
    return statSync(resolve(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `dir` is the user's HOME — i.e. an existing `~/.showtail` is the
 * user's HOME. HOME may be a project for work launched exactly there, but its
 * trail is deliberately ignored while resolving any descendant folder.
 */
export function isHomedirCatchAll(dir: string): boolean {
  return existingPathKey(dir) === existingPathKey(homedir());
}

/** Resolve aliases such as macOS `/var` -> `/private/var` for existing paths. */
export function existingPathKey(p: string): string {
  try {
    return pathKey(realpathSync.native(p));
  } catch {
    return pathKey(p);
  }
}

/** Whether two spellings resolve to the same existing path. */
export function samePath(a: string, b: string): boolean {
  return existingPathKey(a) === existingPathKey(b);
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
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c === p || c.startsWith(prefix);
}

/**
 * Whether `dir` lives under the OS temp directory (or a literal `/tmp` / `\tmp`).
 * This is informational only: temp folders are valid project roots and are not
 * excluded from automatic tracking or inbox surfacing by location.
 */
export function isTempPath(dir: string): boolean {
  return [tmpdir(), '/tmp', '\\tmp'].some((t) => isPathUnder(dir, t));
}

/**
 * The strong project root enclosing `dir`, or null when no existing trail, Git
 * root, or development marker supplies a boundary.
 * Git roots outrank package markers so a monorepo stays one project. An explicit
 * nested trail may scope part of a Git repo; outside Git, a nearer package marker
 * outranks a broad ancestor trail. HOME qualifies only when `dir` itself is HOME.
 */
export function eligibleProjectRoot(dir: string): string | null {
  return projectBoundary(dir)?.root ?? null;
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

interface ProjectBoundary {
  root: string;
  evidence: Extract<ProjectEvidence, 'trail' | 'git' | 'marker'>;
}

/** Select the real project boundary from the candidates found on one path. */
function projectBoundary(startDir: string): ProjectBoundary | null {
  const candidates = projectCandidates(startDir);
  const startKey = existingPathKey(startDir);
  const usable = (candidate: string | null): string | null => {
    if (!candidate) return null;
    // HOME is a valid exact project but never a catch-all for child folders.
    if (isHomedirCatchAll(candidate) && startKey !== existingPathKey(homedir()))
      return null;
    return candidate;
  };
  const trail = usable(candidates.trail);
  const git = usable(candidates.git);
  const marker = usable(candidates.marker);

  if (git) {
    // A trail inside the repository is an intentional nested scope. A trail above
    // the repository is a container/catch-all and must not absorb the repo.
    return trail && isPathUnder(trail, git)
      ? { root: trail, evidence: 'trail' }
      : { root: git, evidence: 'git' };
  }
  if (trail && marker) {
    // Both lie on the same ancestor chain; whichever is deeper is the actual
    // project boundary. Equality chooses the already-initialized trail.
    return isPathUnder(trail, marker)
      ? { root: trail, evidence: 'trail' }
      : { root: marker, evidence: 'marker' };
  }
  if (trail) return { root: trail, evidence: 'trail' };
  if (marker) return { root: marker, evidence: 'marker' };
  return null;
}

/** Lowest common directory for absolute directory paths on one volume. */
function commonDirectory(dirs: string[]): string | null {
  if (dirs.length === 0) return null;
  let common = resolve(dirs[0]!);
  for (const raw of dirs.slice(1)) {
    const dir = resolve(raw);
    if (parse(common).root.toLowerCase() !== parse(dir).root.toLowerCase()) return null;
    while (!isPathUnder(dir, common)) {
      const parent = dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Map<string, string>();
  for (const path of paths) seen.set(existingPathKey(path), resolve(path));
  return [...seen.values()];
}

function contextFor(root: string, evidence: ProjectEvidence): ProjectContext {
  return {
    state: existsSync(join(root, SHOWTAIL_DIR, 'config.json')) ? 'tracked' : 'candidate',
    root: resolve(root),
    evidence,
  };
}

export interface ResolveProjectContextOptions {
  /** `null` disables the process-cwd fallback for persisted/imported evidence. */
  cwd?: string | null;
  editPaths?: string[];
  workspacePaths?: string[];
  /** An explicit command path is authoritative when no stronger boundary exists. */
  explicitPath?: boolean;
}

/**
 * Resolve one deterministic project context from tool/work evidence. Strong
 * boundaries win; plain folders use workspace/edit evidence and finally cwd.
 * Every edited path participates, so mixed-root work is never projected through
 * an escaping relative path.
 */
export function resolveProjectContext(
  options: ResolveProjectContextOptions = {},
): ProjectContext {
  const cwd = options.cwd === null ? null : resolve(options.cwd ?? process.cwd());
  const launchedAtHome = cwd !== null && isHomedirCatchAll(cwd);
  const edits = uniquePaths(options.editPaths ?? []);
  const workspaces = uniquePaths(options.workspacePaths ?? []).filter(
    (workspace) => launchedAtHome || !isHomedirCatchAll(workspace),
  );
  const cwdExists = cwd !== null && isEligibleAnchor(cwd);
  if (!cwdExists && edits.length === 0 && workspaces.length === 0) {
    return { state: 'none', root: null, evidence: null, candidates: [] };
  }

  if (edits.length > 0) {
    const resolvedEdits = edits.map((file) => ({
      file,
      boundary: (() => {
        const boundary = projectBoundary(dirname(file));
        return boundary && isHomedirCatchAll(boundary.root) && !launchedAtHome
          ? null
          : boundary;
      })(),
    }));
    const strongRoots = uniquePaths(
      resolvedEdits.flatMap(({ boundary }) => (boundary ? [boundary.root] : [])),
    );
    if (strongRoots.length > 1) {
      return { state: 'ambiguous', root: null, evidence: null, candidates: strongRoots };
    }
    if (strongRoots.length === 1) {
      const root = strongRoots[0]!;
      const unresolvedOutside = resolvedEdits.some(
        ({ file, boundary }) => !boundary && !isPathUnder(file, root),
      );
      if (unresolvedOutside) {
        const outside = resolvedEdits.flatMap(({ file, boundary }) =>
          boundary || isPathUnder(file, root) ? [] : [dirname(file)],
        );
        return {
          state: 'ambiguous',
          root: null,
          evidence: null,
          candidates: uniquePaths([root, ...outside]),
        };
      }
      const evidence =
        resolvedEdits.find((item) => item.boundary)?.boundary?.evidence ?? 'edit';
      return contextFor(root, evidence);
    }

    const workspaceOwnership = edits.map((file) => {
      const containing = workspaces
        .filter((workspace) => isPathUnder(file, workspace))
        .sort((a, b) => b.length - a.length);
      return { file, owner: containing[0] ?? null };
    });
    const workspaceOwners = workspaceOwnership.flatMap(({ owner }) =>
      owner ? [owner] : [],
    );
    if (workspaceOwners.length > 0 && workspaceOwners.length < edits.length) {
      const ownedRoots = workspaceOwners.map(
        (workspace) => projectBoundary(workspace)?.root ?? workspace,
      );
      const unresolvedRoots = workspaceOwnership.flatMap(({ file, owner }) =>
        owner ? [] : [dirname(file)],
      );
      return {
        state: 'ambiguous',
        root: null,
        evidence: null,
        candidates: uniquePaths([...ownedRoots, ...unresolvedRoots]),
      };
    }
    if (workspaceOwners.length === edits.length) {
      const roots = uniquePaths(
        workspaceOwners.map((workspace) => projectBoundary(workspace)?.root ?? workspace),
      );
      if (roots.length > 1) {
        return { state: 'ambiguous', root: null, evidence: null, candidates: roots };
      }
      const workspace = roots[0]!;
      const boundary = projectBoundary(workspace);
      return contextFor(boundary?.root ?? workspace, boundary?.evidence ?? 'workspace');
    }

    // A normal tool cwd is the most stable fallback: editing `cwd/src/x.ts`
    // must not accidentally turn `src/` into the project. HOME is different—its
    // trail is local-only, so edits beneath it reveal a more specific project.
    if (
      cwd !== null &&
      cwdExists &&
      !isHomedirCatchAll(cwd) &&
      edits.every((file) => isPathUnder(file, cwd))
    ) {
      const boundary = projectBoundary(cwd);
      return contextFor(boundary?.root ?? cwd, boundary?.evidence ?? 'cwd');
    }

    const common = commonDirectory(edits.map((file) => dirname(file)));
    if (!common) {
      return {
        state: 'ambiguous',
        root: null,
        evidence: null,
        candidates: uniquePaths(edits.map((file) => dirname(file))),
      };
    }
    // HOME, the OS temp container, and a filesystem root commonly hold unrelated
    // sibling projects. They remain valid when supplied as cwd/workspace evidence,
    // but must not be inferred merely because unrelated edit paths share them.
    if (isHomedirCatchAll(common) && !launchedAtHome) {
      const candidates = uniquePaths(
        edits.flatMap((file) => (samePath(dirname(file), common) ? [] : [dirname(file)])),
      );
      return candidates.length > 0
        ? { state: 'ambiguous', root: null, evidence: null, candidates }
        : { state: 'none', root: null, evidence: null, candidates: [] };
    }
    if (
      (isHomedirCatchAll(common) ||
        samePath(common, tmpdir()) ||
        common === parse(common).root) &&
      edits.some((file) => !samePath(dirname(file), common))
    ) {
      return {
        state: 'ambiguous',
        root: null,
        evidence: null,
        candidates: uniquePaths(edits.map((file) => dirname(file))),
      };
    }
    return contextFor(common, 'edit');
  }

  if (workspaces.length > 0) {
    const roots = uniquePaths(
      workspaces.map((workspace) => projectBoundary(workspace)?.root ?? workspace),
    );
    if (roots.length > 1) {
      const deepest = roots.find((candidate) =>
        roots.every((other) => isPathUnder(candidate, other)),
      );
      if (deepest) return contextFor(deepest, 'workspace');
      return { state: 'ambiguous', root: null, evidence: null, candidates: roots };
    }
    const workspace = roots[0]!;
    const boundary = projectBoundary(workspace);
    return contextFor(boundary?.root ?? workspace, boundary?.evidence ?? 'workspace');
  }

  if (!cwdExists || cwd === null) {
    return { state: 'none', root: null, evidence: null, candidates: [] };
  }
  const boundary = projectBoundary(cwd);
  if (boundary) return contextFor(boundary.root, boundary.evidence);
  return contextFor(cwd, options.explicitPath ? 'explicit' : 'cwd');
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
export function ensureTrailId(
  paths: ShowtailPaths,
  continueCapture?: () => boolean,
): string {
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
  requireCaptureContinuation(continueCapture);
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

/** Clear stale turn linkage after an uncaptured user boundary. */
export function clearTurnForNativeSession(
  paths: ShowtailPaths,
  nativeSessionId: string,
): void {
  const state = readState(paths);
  if (!state.turnByNativeSession?.[nativeSessionId]) return;
  const turnByNativeSession = { ...state.turnByNativeSession };
  delete turnByNativeSession[nativeSessionId];
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
export function migrateLegacySessions(
  author: AuthorPaths,
  continueCapture?: () => boolean,
): void {
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
  requireCaptureContinuation(continueCapture);
  writeJson(shardFile, [...byId.values()]);
  requireCaptureContinuation(continueCapture);
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
