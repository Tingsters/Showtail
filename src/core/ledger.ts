/**
 * The machine-local durable ledger — Showtail's source of truth for *every*
 * session, recorded before (and independent of) any project root resolving. A
 * repo's `.showtail/` is a *projection* of the sessions the ledger placed there.
 *
 * Why it exists: routing captures by `findRoot(cwd)` works for folder-bound
 * tools, but breaks for global/folderless ones — a scratch IDE workspace with no
 * folder open, an agent whose state lives in HOME, a zero-edit planning session.
 * For those the old hook silently no-opped and the work was dropped. The ledger
 * catches all of it: the student's prompts and the files they changed land here
 * first, keyed by the tool's own session, and are later *materialized* into the
 * right repo (live when a root resolves, or on demand via `showtail reattach`).
 *
 * Layout (under {@link ledgerDir}, never inside a repo):
 *   index.json                     — trailId↔path map + session→trail placements
 *   sessions/<id>/session.json     — {@link LedgerSession} metadata
 *   sessions/<id>/records.jsonl    — append-only {@link LedgerRecord} capture
 *
 * Concurrency: each session has its own directory keyed by the (tool, native
 * session, machine) triple, so two concurrent tool sessions never share a file.
 * `records.jsonl` is append-only (atomic per-line writes); `session.json` uses
 * atomic temp+rename tolerance. Identity-bearing session and index writes share
 * a machine-wide lock with trail retirement so a retired id cannot race back in.
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ConversationEvent, Tool } from '../types.ts';
import { CaptureInterruptedError, requireCaptureContinuation } from './captureGuard.ts';
import {
  assertTrailIdentityActive,
  ledgerDir,
  readGlobalConfig,
  readInboxMinSignal,
  readScratchPaths,
  recordTrailIdentitySupersession,
  trailIdentitySupersession,
  withTrailIdentityMutationLock,
} from './globalConfig.ts';
import { makeId } from './ids.ts';
import { applyPathRebases, type PathRebase } from './pathRebase.ts';
import {
  appendJsonl,
  isPathUnder,
  pathKey,
  readJson,
  readJsonl,
  resolveProjectContext,
  writeJson,
  type ProjectContext,
} from './storage.ts';

/** Cap a single captured diff stored inline so one huge edit can't bloat the ledger. */
const MAX_DIFF_BYTES = 64 * 1024;

/** Whether a session has been placed into at least one trail, or still awaits one. */
export type LedgerStatus = 'placed' | 'inbox';

/** A trail this session was materialized into. */
export interface LedgerTarget {
  trailId: string;
  /** Last-known absolute path of the trail (a hint; the trailId is authoritative). */
  path: string;
}

/** One session's metadata in the ledger. */
export interface LedgerSession {
  /** Ledger id (`led_…`), also the shard-directory name. */
  id: string;
  tool: Tool;
  /** The tool's own session id — the keying field (the ledger is already machine-local). */
  nativeSessionId: string;
  /** The capturing machine's id when known. Informational — not used for keying. */
  machineId?: string;
  /** Author slug, when this machine's identity is known (for projection attribution). */
  slug?: string;
  /**
   * Working directory at capture time — the cwd-fallback target when no edit-path
   * root resolves. `null` means the host explicitly had no project cwd.
   */
  cwd?: string | null;
  /** Workspace roots reported by the host tool, accumulated across hook events. */
  workspacePaths?: string[];
  /**
   * Ordered project moves applied to capture-time paths when routing and
   * materializing this session. Raw ledger records stay unchanged provenance.
   */
  pathRebases?: PathRebase[];
  startedAt: string;
  endedAt?: string;
  lastSeenAt: string;
  status: LedgerStatus;
  /** Trails this session has been projected into (empty ⇒ inbox). */
  targets?: LedgerTarget[];
  /** Ledger record id of the prompt that opened the current turn (replay linkage). */
  currentTurnKey?: string;
  /**
   * Last-known path of the host tool's own transcript for this session, recorded
   * whenever a hook hands us one. The catch-up sweep re-reads it to recover
   * content the live hooks couldn't see: hosts write the transcript
   * asynchronously (Claude Code documents `transcript_path` as "written
   * asynchronously, may lag current turn"), and its end-of-turn recap lands
   * minutes after the last hook has run. Stored per session because a session's
   * `cwd` often isn't the trail root, so the transcript can't be found by path
   * matching alone.
   */
  transcriptPath?: string;
  /**
   * When set, the student explicitly dismissed this (still-`inbox`) session from the
   * default `showtail inbox` view. It stays in the ledger and under `--all`/`move` —
   * dismissal is a reversible view filter, not a delete. Cleared on (re)placement.
   */
  dismissedAt?: string;
}

/** The kind of a single captured record. */
export type LedgerRecordKind =
  | 'prompt'
  | 'ai_output'
  | 'decision'
  | 'plan'
  | 'edit'
  | 'tool_call'
  | 'recap'
  | 'conversation_event';

/** One append-only capture line in a session's `records.jsonl`. */
export interface LedgerRecord {
  /** Record id, unique within the session; becomes the synthetic projection sourceId. */
  id: string;
  ts: string;
  kind: LedgerRecordKind;
  tool: Tool;
  /** Content for prompt/ai_output/decision/plan (stored raw; redacted at materialize). */
  text?: string;
  /** Absolute path of an edited file (kind === 'edit'); re-relativized at materialize. */
  file?: string;
  /** Captured diff for an edit, if the tool supplied one. */
  diff?: string;
  /** True when the edit removed the file. */
  deleted?: boolean;
  /** The opening prompt's record id, so replies/edits re-link to their turn on replay. */
  turnKey?: string;
  /** Plan approval state, when the tool resolves it. */
  approved?: boolean;
  /**
   * For a `plan` whose tool wrote a real on-disk plan file (Antigravity): the
   * file's content and stable id, so the projection links the canonical plan file
   * (`plans/<id>.md`) instead of materializing the transcript's plan text.
   */
  planFileContent?: string;
  planFileSourceId?: string;
  /**
   * Git commit captured at the moment of capture (prompt/edit). Carried so a
   * projection keeps the real commit — `materialize` back-dates events, and a
   * back-dated `logEvent` would otherwise drop the commit. Parity foundation for
   * the writer-flip (the repo becoming a pure projection).
   */
  gitCommit?: string;
  /** SHA-256 of an edited file at capture time, so a projected snapshot keeps its integrity hash. */
  sha256?: string;
  /** Upstream source id (e.g. a transcript message id), when one exists. */
  sourceId?: string;
  /** Earlier raw record replaced by this append-only transcript correction. */
  supersedesRecordId?: string;
  /** Whether the provider had persisted its completed response for this record. */
  transcriptFinal?: boolean;
  /**
   * Project context observed for this record. New writers may attach it to a
   * prompt when the host reports a workspace/cwd change. Older records omit it;
   * an edit-less turn then inherits only the preceding unambiguous turn.
   */
  context?: {
    cwd?: string | null;
    workspacePaths?: string[];
    /** Only turn-scoped context may override an already-resolved preceding turn. */
    scope?: 'turn' | 'session';
  };
  /** Provider-neutral structured event for a `conversation_event` record. */
  conversationEvent?: ConversationEvent;
  /** For a `tool_call` record: the tool's name (e.g. `Bash`, `Read`, `Grep`). */
  toolName?: string;
  /** For a `tool_call` record: whether its result was an error. */
  isError?: boolean;
  /** For a `recap` record: the turn's wall-clock duration, in milliseconds. */
  durationMs?: number;
  /** For a `recap` record: the git branch at the time the turn closed. */
  gitBranch?: string;
  /** For a `recap` record: input tokens used across the turn. */
  inputTokens?: number;
  /** For a `recap` record: output tokens used across the turn. */
  outputTokens?: number;
  /** For a `recap` record: cache-read tokens used across the turn. */
  cacheReadTokens?: number;
  /** For a `recap` record: cache-creation tokens used across the turn. */
  cacheCreationTokens?: number;
}

/** Current on-disk schema for a session's derived turn-routing sidecar. */
export const LEDGER_SEGMENTS_VERSION = 2;

/** Current schema for a trusted Showtail control result bound to one native turn. */
export const LEDGER_PROJECT_BINDING_VERSION = 1;

export type LedgerProjectControlAction = 'report' | 'open_report' | 'status' | 'verify';

/** An explicit file or folder attached by the student to one native request. */
export interface LedgerProjectAttachment {
  kind: 'file' | 'folder';
  path: string;
}

/**
 * A validated Showtail-owned project selection. The trail id is identity; `root`
 * is a moveable hint that must still resolve to that exact trail before routing.
 */
export interface LedgerProjectControlTarget {
  schemaVersion: typeof LEDGER_PROJECT_BINDING_VERSION;
  source: 'showtail-project-control';
  nativeSessionId: string;
  nativeRequestId: string;
  claimId: string;
  action: LedgerProjectControlAction;
  trailId: string;
  root: string;
  displayName?: string;
  mode: 'authoritative' | 'corroborated';
  evidence: string[];
  crossWorkspace?: boolean;
  reportPath?: string;
  boundAt: string;
}

/** Validated marker data before it is associated with a ledger session/turn. */
export type LedgerProjectControlInput = Omit<
  LedgerProjectControlTarget,
  'schemaVersion' | 'source' | 'nativeSessionId' | 'nativeRequestId' | 'boundAt'
>;

/** A routeable prompt turn (or the leading records before the first prompt). */
export interface LedgerSegment {
  /** Stable id derived from the opening prompt record id. */
  id: string;
  /** Prompt record that opened this turn; absent only for leading orphan records. */
  promptRecordId?: string;
  /** Immutable ledger record ids assigned to this turn, in ledger write order. */
  recordIds: string[];
  /** Native provider request id, when the transcript exposes one. */
  nativeRequestId?: string;
  /** Explicit student attachments observed on this exact request. */
  attachments?: LedgerProjectAttachment[];
  /** Trusted Showtail control target for this exact request. */
  controlTarget?: LedgerProjectControlTarget;
  startedAt: string;
  endedAt: string;
  status: LedgerStatus;
  targets?: LedgerTarget[];
  dismissedAt?: string;
  /** Project moves apply to this turn only, so moving A never rebases B. */
  pathRebases?: PathRebase[];
  /** Crash-resumable state for destination-first routing reprojection. */
  migration?: LedgerSegmentMigration;
}

export type LedgerSegmentMigrationPhase =
  | 'planned'
  | 'destination-materialized'
  | 'obsolete-projections-removed'
  | 'complete';

export interface LedgerSegmentMigration {
  phase: LedgerSegmentMigrationPhase;
  destination: LedgerTarget;
  /** Placements observed before the destination write; retained for retries. */
  sourceTargets: LedgerTarget[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Versioned, rebuildable sidecar stored beside records.jsonl. */
export interface LedgerSegmentsDocument {
  version: typeof LEDGER_SEGMENTS_VERSION;
  recordCount: number;
  lastRecordId?: string;
  segments: LedgerSegment[];
}

/** Segment route plus whether it was inherited from the preceding turn. */
export type LedgerSegmentProjectContext =
  | (Extract<ProjectContext, { state: 'tracked' | 'candidate' }> & {
      inheritedFrom?: string;
    })
  | Extract<ProjectContext, { state: 'ambiguous' | 'none' }>;

/** Command-friendly view of one independently routeable turn range. */
export interface LedgerSegmentView {
  selector: string;
  session: LedgerSession;
  segment: LedgerSegment;
  route: LedgerSegmentProjectContext;
  targetMissing: boolean;
  targetPaths: string[];
  prompts: number;
  edits: number;
  firstPrompt?: string;
  hiddenReason: HiddenReason | null;
}

/** Consecutive pending turns that can be acted on as one command-level range. */
export interface LedgerRangeView extends LedgerSegmentView {
  /** Stable ids of every persisted segment represented by this range. */
  memberSegmentIds: string[];
  segments: LedgerSegment[];
}

/** The global cross-session index: trail locations and where each session was placed. */
export interface LedgerIndex {
  version: number;
  /** Session key (tool + native id) → ledger session id, for find-or-create without scanning. */
  byKey: Record<string, string>;
  /** trailId → its last-known location (updated on every placement; powers move detection). */
  trails: Record<string, { path: string; lastSeenAt: string }>;
  /** ledger session id → the trail ids it has been projected into. */
  sessions: Record<string, string[]>;
}

// --- paths ----------------------------------------------------------------

function indexFile(): string {
  return join(ledgerDir(), 'index.json');
}
function sessionsDir(): string {
  return join(ledgerDir(), 'sessions');
}
function sessionDir(id: string): string {
  return join(sessionsDir(), id);
}
function sessionFile(id: string): string {
  return join(sessionDir(id), 'session.json');
}
function recordsFile(id: string): string {
  return join(sessionDir(id), 'records.jsonl');
}
function segmentsFile(id: string): string {
  return join(sessionDir(id), 'segments.json');
}

/**
 * The key that identifies a tool session across its separate hook processes.
 * The ledger lives under `SHOWTAIL_HOME` (one machine), so the tool id + the
 * tool's own session id are enough — no machine id, which also avoids depending
 * on an identity that may not be cached yet when the first hook fires.
 */
function sessionKey(tool: Tool, nativeSessionId: string): string {
  return `${tool}\t${nativeSessionId}`;
}

// --- index ----------------------------------------------------------------

const EMPTY_INDEX: LedgerIndex = { version: 1, byKey: {}, trails: {}, sessions: {} };

/** Read the ledger index, tolerating a missing/corrupt file with a safe default. */
export function readLedgerIndex(): LedgerIndex {
  const file = indexFile();
  if (!existsSync(file)) return { ...EMPTY_INDEX, byKey: {}, trails: {}, sessions: {} };
  try {
    const idx = readJson<Partial<LedgerIndex>>(file);
    return {
      version: idx.version ?? 1,
      byKey: idx.byKey ?? {},
      trails: idx.trails ?? {},
      sessions: idx.sessions ?? {},
    };
  } catch {
    return { ...EMPTY_INDEX, byKey: {}, trails: {}, sessions: {} };
  }
}

function assertLedgerIndexActive(index: LedgerIndex): void {
  const config = readGlobalConfig();
  for (const trailId of Object.keys(index.trails)) {
    assertTrailIdentityActive(trailId, config);
  }
  for (const trailIds of Object.values(index.sessions)) {
    for (const trailId of trailIds) assertTrailIdentityActive(trailId, config);
  }
}

/** Read-modify-write the index atomically (tolerant of a concurrent writer). */
function updateLedgerIndex(
  mutate: (idx: LedgerIndex) => void,
  continueCapture?: () => boolean,
): LedgerIndex {
  return withTrailIdentityMutationLock(() => {
    requireCaptureContinuation(continueCapture);
    const idx = readLedgerIndex();
    mutate(idx);
    assertLedgerIndexActive(idx);
    requireCaptureContinuation(continueCapture);
    writeJson(indexFile(), idx);
    return idx;
  });
}

// --- sessions -------------------------------------------------------------

/** Read one ledger session's metadata, or null if it isn't there. */
export function readLedgerSession(id: string): LedgerSession | null {
  const file = sessionFile(id);
  if (!existsSync(file)) return null;
  try {
    return readJson<LedgerSession>(file);
  } catch {
    return null;
  }
}

function samePathRebase(a: PathRebase, b: PathRebase): boolean {
  return (
    pathKey(resolve(a.fromRoot)) === pathKey(resolve(b.fromRoot)) &&
    pathKey(resolve(a.toRoot)) === pathKey(resolve(b.toRoot))
  );
}

function isRebasePrefix(
  prefix: readonly PathRebase[],
  complete: readonly PathRebase[],
): boolean {
  return (
    prefix.length <= complete.length &&
    prefix.every((rebase, index) => samePathRebase(rebase, complete[index]!))
  );
}

/** Persist one ledger session's metadata (atomic temp+rename). */
export function writeLedgerSession(
  session: LedgerSession,
  continueCapture?: () => boolean,
  opts: { preservePathRebases?: boolean } = {},
): void {
  requireCaptureContinuation(continueCapture);
  let next = session;
  if (opts.preservePathRebases !== false) {
    const persisted = readLedgerSession(session.id);
    const incoming = session.pathRebases ?? [];
    const current = persisted?.pathRebases ?? [];
    if (current.length > incoming.length && isRebasePrefix(incoming, current)) {
      next = {
        ...session,
        pathRebases: current.map((rebase) => ({ ...rebase })),
      };
    }
  }
  writeJson(sessionFile(session.id), next);
}

/** Fields needed to find or open a ledger session. */
export interface EnsureLedgerSessionInput {
  tool: Tool;
  /** The tool's own session id — required: it's how the ledger correlates hook events. */
  nativeSessionId: string;
  /** The capturing machine's id when known (informational; not part of the key). */
  machineId?: string;
  slug?: string;
  /** `null` preserves an explicit folderless host context. */
  cwd?: string | null;
  workspacePaths?: string[];
  /** Recheck an automatic caller's capture window at each ledger write. */
  continueCapture?: () => boolean;
}

function mergePathHints(current: string[] | undefined, incoming: string[]): string[] {
  const merged = new Map<string, string>();
  for (const value of [...(current ?? []), ...incoming]) {
    const absolute = resolve(value);
    merged.set(pathKey(absolute), absolute);
  }
  return [...merged.values()];
}

/**
 * Find the open ledger session for a tool session, creating it on first sight.
 * Mirrors {@link sessionForNativeSession}: binds to the *open* session for the
 * keying triple; a session already ended (idle/SessionEnd) is left in place and a
 * continuation gets a fresh one. Re-reads the index right before writing to
 * shrink the window a concurrent first-hook could clobber the push.
 */
export function ensureLedgerSession(input: EnsureLedgerSessionInput): LedgerSession {
  requireCaptureContinuation(input.continueCapture);
  const key = sessionKey(input.tool, input.nativeSessionId);
  const now = new Date().toISOString();

  const idx = readLedgerIndex();
  const existingId = idx.byKey[key];
  if (existingId) {
    const existing = readLedgerSession(existingId);
    if (existing && !existing.endedAt) {
      // Refresh the cheap, mutable hints; keep the rest as-is.
      existing.lastSeenAt = now;
      if (input.cwd !== undefined && existing.cwd === undefined) {
        existing.cwd = input.cwd;
      }
      if (input.slug && !existing.slug) existing.slug = input.slug;
      if (input.workspacePaths && input.workspacePaths.length > 0) {
        existing.workspacePaths = mergePathHints(
          existing.workspacePaths,
          input.workspacePaths,
        );
      }
      writeLedgerSession(existing, input.continueCapture);
      return readLedgerSession(existing.id) ?? existing;
    }
  }

  const session: LedgerSession = {
    id: makeId('led'),
    tool: input.tool,
    nativeSessionId: input.nativeSessionId,
    machineId: input.machineId,
    slug: input.slug,
    cwd: input.cwd,
    ...(input.workspacePaths && input.workspacePaths.length > 0
      ? { workspacePaths: mergePathHints(undefined, input.workspacePaths) }
      : {}),
    startedAt: now,
    lastSeenAt: now,
    status: 'inbox',
  };
  // Claim the key under a fresh read: if a concurrent hook just opened a session
  // for the same triple, adopt theirs and leave ours an unindexed orphan dir
  // (harmless — never listed). Otherwise take the slot. If consent changes after
  // the session file is staged but before the index write, remove our unindexed
  // directory so an interrupted automatic capture leaves no ghost session.
  let winnerId = session.id;
  try {
    writeLedgerSession(session, input.continueCapture);
    updateLedgerIndex((i) => {
      const open = i.byKey[key];
      const openSession = open ? readLedgerSession(open) : null;
      if (openSession && !openSession.endedAt) {
        winnerId = open!;
      } else {
        i.byKey[key] = session.id;
        winnerId = session.id;
      }
    }, input.continueCapture);
  } catch (error) {
    if (error instanceof CaptureInterruptedError) {
      rmSync(sessionDir(session.id), { recursive: true, force: true });
    }
    throw error;
  }
  if (winnerId !== session.id) {
    return readLedgerSession(winnerId) ?? session;
  }
  return session;
}

/** Stamp a session ended (idempotent — keeps the first end time). */
export function endLedgerSession(id: string): void {
  const session = readLedgerSession(id);
  if (!session || session.endedAt) return;
  session.endedAt = new Date().toISOString();
  writeLedgerSession(session);
}

/** Record or clear the prompt record id that opens the current turn. */
export function setLedgerTurn(id: string, turnKey: string | undefined): void {
  const session = readLedgerSession(id);
  if (!session) return;
  if (turnKey) session.currentTurnKey = turnKey;
  else delete session.currentTurnKey;
  writeLedgerSession(session);
}

/**
 * Remember where this session's host transcript lives, so the catch-up sweep can
 * re-read it later (see {@link LedgerSession.transcriptPath}). No-op when the
 * path is already recorded, so the common case costs nothing.
 */
export function setLedgerTranscriptPath(
  id: string,
  transcriptPath: string,
  continueCapture?: () => boolean,
): void {
  requireCaptureContinuation(continueCapture);
  const session = readLedgerSession(id);
  if (!session || session.transcriptPath === transcriptPath) return;
  session.transcriptPath = transcriptPath;
  writeLedgerSession(session, continueCapture);
}

/** Every ledger session, newest activity first. */
export function allLedgerSessions(): LedgerSession[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: LedgerSession[] = [];
  for (const name of readdirSync(dir)) {
    const s = readLedgerSession(name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

// --- inbox surfacing (triage) --------------------------------------------

/** Resolve a capture-time path through every project move recorded for the session. */
export function effectiveLedgerPath(
  session: LedgerSession,
  path: string,
  additionalRebase?: PathRebase,
): string {
  const effective = applyPathRebases(session.pathRebases, path);
  const previous = session.pathRebases?.at(-1);
  if (additionalRebase && (!previous || !samePathRebase(previous, additionalRebase))) {
    return applyPathRebases([additionalRebase], effective);
  }
  return effective;
}

/** Prompt/edit counts, first prompt text, and effective absolute edit paths. */
function sessionFacts(sessionOrId: LedgerSession | string): {
  prompts: number;
  edits: number;
  firstPrompt?: string;
  editPaths: string[];
} {
  const session =
    typeof sessionOrId === 'string' ? readLedgerSession(sessionOrId) : sessionOrId;
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
  let prompts = 0;
  let edits = 0;
  let firstPrompt: string | undefined;
  const editPaths: string[] = [];
  for (const rec of effectiveLedgerRecords(readLedgerRecords(id))) {
    if (rec.kind === 'edit') {
      edits += 1;
      if (rec.file)
        editPaths.push(session ? effectiveLedgerPath(session, rec.file) : rec.file);
    } else if (rec.kind === 'prompt') {
      prompts += 1;
      if (!firstPrompt && rec.text) firstPrompt = rec.text;
    }
  }
  return { prompts, edits, firstPrompt, editPaths };
}

/** Whether recorded edit files remain at their capture-time paths. */
export type SessionEditPresence = 'none' | 'all-present' | 'all-absent' | 'mixed';

/** Unique absolute file paths edited by a session, in first-capture order. */
export function sessionEditPaths(session: LedgerSession | string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of sessionFacts(session).editPaths) {
    const key = pathKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(file);
  }
  return paths;
}

/** Classify a session as a move, copy, or partial move without changing the ledger. */
export function sessionEditPresence(
  session: LedgerSession | string,
): SessionEditPresence {
  const paths = sessionEditPaths(session);
  if (paths.length === 0) return 'none';
  const present = paths.reduce((count, file) => count + Number(existsSync(file)), 0);
  if (present === paths.length) return 'all-present';
  if (present === 0) return 'all-absent';
  return 'mixed';
}

/** One session worth considering for content-lineage relocation into a new root. */
export interface RelocationSessionSource {
  session: LedgerSession;
  /** Best known capture-time project location, for review output. */
  from?: string;
  /** `all-present` copies and edit-less sessions never enter relocation matching. */
  editPresence: 'all-absent' | 'mixed';
}

/**
 * Read-only source set for moved-work discovery.
 *
 * Inbox and target-missing sessions were already recoverable; this deliberately
 * widens discovery to a session whose old trail is still alive after the student
 * moved only the visible project files. A placed session is eligible only when it
 * has one prior target. Sessions already placed here, multi-target sessions, and
 * copies whose original files still exist are excluded before content matching.
 */
export function relocationSessionSources(targetRoot: string): RelocationSessionSource[] {
  const target = resolve(targetRoot);
  const sources: RelocationSessionSource[] = [];
  for (const session of allLedgerSessions()) {
    const editPresence = sessionEditPresence(session);
    if (editPresence === 'none' || editPresence === 'all-present') continue;

    // Relocation is session-atomic. A single recorded placement does not make
    // edits spanning several project roots safe to move as one unit.
    const context = sessionProjectContext(session);
    if (context.state === 'ambiguous') continue;

    const targets = session.targets ?? [];
    let from: string | undefined;
    if (session.status === 'placed') {
      if (targets.length !== 1) continue;
      const prior = targets[0]!;
      from = knownTrailPath(prior.trailId) ?? prior.path;
      if (sameDirectory(from, target)) continue;
    } else {
      // A malformed/stale inbox record with several placements is no safer to
      // relocate than an explicitly multi-target placed session.
      if (targets.length > 1) continue;
      if (context.state === 'tracked' || context.state === 'candidate') {
        from = context.root;
        if (sameDirectory(from, target)) continue;
      } else if (typeof session.cwd === 'string') {
        from = effectiveLedgerPath(session, session.cwd);
      }
    }

    sources.push({ session, from, editPresence });
  }
  return sources;
}

/** Prompt/edit counts for a session — the surfacing signal. */
export function sessionSignal(id: string): { prompts: number; edits: number } {
  const { prompts, edits } = sessionFacts(id);
  return { prompts, edits };
}

/** Prompt/edit counts plus the first prompt text (the shared list/picker summary). */
export function sessionSummary(id: string): {
  prompts: number;
  edits: number;
  firstPrompt?: string;
} {
  const { prompts, edits, firstPrompt } = sessionFacts(id);
  return { prompts, edits, firstPrompt };
}

/** Resolve the deterministic project context represented by one ledger session. */
export function sessionProjectContext(session: LedgerSession): ProjectContext {
  const facts = sessionFacts(session);
  if (isNativeEditorSession(session)) {
    const document = ensureLedgerSegments(session);
    const routes = [...ledgerSegmentProjectContexts(session, document).values()];
    const ambiguous = routes.flatMap((route) =>
      route.state === 'ambiguous' ? route.candidates : [],
    );
    const resolved = routes.flatMap((route) =>
      route.state === 'tracked' || route.state === 'candidate' ? [route] : [],
    );
    const roots = new Map<string, string>();
    for (const route of resolved) roots.set(pathKey(route.root), route.root);
    for (const root of ambiguous) roots.set(pathKey(root), root);
    if (ambiguous.length > 0 || roots.size > 1) {
      return {
        state: 'ambiguous',
        root: null,
        evidence: null,
        candidates: [...roots.values()],
      };
    }
    if (resolved.length > 0) {
      const route =
        resolved.find((candidate) => candidate.state === 'tracked') ?? resolved[0]!;
      return { state: route.state, root: route.root, evidence: route.evidence };
    }
    return { state: 'none', root: null, evidence: null, candidates: [] };
  }
  if (
    !session.cwd &&
    facts.editPaths.length === 0 &&
    (!session.workspacePaths || session.workspacePaths.length === 0)
  ) {
    return { state: 'none', root: null, evidence: null, candidates: [] };
  }
  return resolveProjectContext({
    // A ledger session must resolve only from evidence captured with that
    // session, never from whichever folder this Showtail process happens to use.
    cwd:
      typeof session.cwd === 'string'
        ? effectiveLedgerPath(session, session.cwd)
        : (session.cwd ?? null),
    editPaths: facts.editPaths,
    workspacePaths: session.workspacePaths?.map((path) =>
      effectiveLedgerPath(session, path),
    ),
  });
}

/**
 * The project roots a session resolves to. A deterministic session has one root;
 * ambiguous multi-project work returns every candidate so callers keep it in the
 * inbox rather than silently dropping the unresolved paths.
 */
export function sessionWorkRoots(session: LedgerSession): string[] {
  const context = sessionProjectContext(session);
  if (context.state === 'tracked' || context.state === 'candidate') return [context.root];
  return context.state === 'ambiguous' ? context.candidates : [];
}

/**
 * Whether any of the session's edit paths (or its `cwd`, when edit-less) is under
 * `folder` — a raw prefix membership test (NOT resolved-root), so targeting a
 * subfolder of a session's git/`.showtail` root still matches. Powers the scratch
 * list and `track`'s backfill.
 */
export function sessionTouchesPath(session: LedgerSession, folder: string): boolean {
  const targets = recordedPaths(
    sessionFacts(session),
    typeof session.cwd === 'string'
      ? effectiveLedgerPath(session, session.cwd)
      : session.cwd,
    session.workspacePaths?.map((path) => effectiveLedgerPath(session, path)),
  );
  return targets.some((p) => isPathUnder(p, folder));
}

/**
 * The recorded locations of a session's work: its edited files, or its `cwd` when
 * it made no edits. These are absolute and machine-local (see the module note), so
 * they are exactly what goes stale when the student moves their files.
 */
function recordedPaths(
  facts: { editPaths: string[] },
  cwd?: string | null,
  workspacePaths?: string[],
): string[] {
  if (facts.editPaths.length > 0) return facts.editPaths;
  if (workspacePaths && workspacePaths.length > 0) return workspacePaths;
  return cwd ? [cwd] : [];
}

/**
 * Whether every path this session recorded has vanished from disk — the signature
 * of moved (or deleted) work, as opposed to work that simply never sat in a
 * project. Worth distinguishing because the two need opposite treatment: a folder
 * that isn't a project is genuinely scratch, while work whose files moved is real
 * work that must stay visible so it can be recovered (see {@link hiddenReason}).
 */
export function sessionPathsGone(session: LedgerSession): boolean {
  const { editPaths } = sessionFacts(session);
  if (editPaths.length > 0) {
    if (editPaths.some((p) => existsSync(p))) return false;
    // The *location* has to be gone, not merely the file. A missing file inside a
    // directory that still exists is a deletion, and that directory can still be
    // judged on its own merits (it may simply never have been a project) — whereas a
    // missing containing directory is the signature of the whole folder having been
    // moved or renamed, which is the case we must keep visible.
    return editPaths.some((p) => !existsSync(dirname(p)));
  }
  // An edit-less session records only its `cwd`, and that directory IS the location
  // — so its own absence is the signal (checking its parent would ask about the
  // wrong folder entirely).
  return (
    typeof session.cwd === 'string' &&
    !existsSync(effectiveLedgerPath(session, session.cwd))
  );
}

/** Why a session is hidden from the default inbox, or null when it surfaces. */
export type HiddenReason = 'dismissed' | 'not-in-project' | 'low-signal' | 'ignored-path';

/**
 * The reason a never-placed session is hidden (see {@link isSurfaced}), or null.
 *
 * Note the deliberate asymmetry fix: when a session's recorded paths have all
 * vanished, project resolution cannot resolve a root and would report
 * `'not-in-project'` — hiding moved work in the one view the student is told to
 * check. Gone paths therefore skip that verdict and fall through to the ordinary
 * signal/scratch filters, mirroring the guarantee `unplacedSessions` already gives
 * target-missing sessions. Trivial gone-path sessions still stay hidden as
 * `'low-signal'`, so the default inbox doesn't fill up with noise.
 */
export function hiddenReason(session: LedgerSession): HiddenReason | null {
  if (session.dismissedAt) return 'dismissed';
  const facts = sessionFacts(session);
  if (sessionWorkRoots(session).length === 0 && !sessionPathsGone(session))
    return 'not-in-project';
  const min = readInboxMinSignal();
  if (!(facts.edits >= min.edits || facts.prompts >= min.prompts)) return 'low-signal';
  const targets = recordedPaths(
    facts,
    typeof session.cwd === 'string'
      ? effectiveLedgerPath(session, session.cwd)
      : session.cwd,
    session.workspacePaths?.map((path) => effectiveLedgerPath(session, path)),
  );
  const scratch = readScratchPaths();
  if (scratch.some((s) => targets.some((p) => isPathUnder(p, s)))) return 'ignored-path';
  return null;
}

/** Whether a never-placed session surfaces in the default `showtail inbox`. */
export function isSurfaced(session: LedgerSession): boolean {
  return hiddenReason(session) === null;
}

/**
 * Sessions awaiting placement: explicitly `inbox`, or `placed` into a trail that
 * has since gone missing (a deleted repo, or a moved one not yet re-seen). The
 * `targetMissing` flag tells the two apart for the `inbox` listing.
 *
 * By default only *surfaced* inbox sessions are returned (project-resolved,
 * signal-bearing, not ignored/dismissed); `includeHidden` returns every inbox session so
 * `showtail inbox --all` can reveal the rest. `target-missing` sessions always
 * surface — they are placed real work whose repo vanished.
 */
export function unplacedSessions(
  opts: { includeHidden?: boolean; repairTargets?: boolean } = {},
): Array<LedgerSession & { targetMissing?: boolean; pathGone?: boolean }> {
  const out: Array<LedgerSession & { targetMissing?: boolean; pathGone?: boolean }> = [];
  for (const session of allLedgerSessions()) {
    if (session.status === 'inbox') {
      if (opts.includeHidden || isSurfaced(session)) {
        // Flagged so the listing can say "moved or deleted" instead of leaving the
        // student to wonder why a session points at a folder that isn't there.
        const pathGone = sessionPathsGone(session);
        out.push(pathGone ? { ...session, pathGone } : session);
      }
      continue;
    }
    // Placed: surface it only if every recorded target is now missing. The
    // Mutating callers may repair a trailId that diverged under a merge (CC2), so
    // a valid trail at the path is never mistaken for a missing one. Read-only
    // probes explicitly disable that repair and only observe whether a trail is
    // present at the recorded location.
    const targets = session.targets ?? [];
    if (targets.length === 0) continue;
    const anyAlive = targets.some((t) =>
      targetAlive(session.id, t, opts.repairTargets !== false),
    );
    if (!anyAlive) out.push({ ...session, targetMissing: true });
  }
  return out;
}

/** A ledger session annotated with its current placement, for listing / move UIs. */
export interface LedgerSessionView extends LedgerSession {
  /** Placed, but every recorded trail is now missing (deleted/moved). */
  targetMissing: boolean;
  /** Current (alive-where-known) trail paths this session is placed in. */
  targetPaths: string[];
}

/**
 * Every ledger session annotated with placement — placed (with its current
 * folder), inbox, or target-missing. Mutating callers may self-heal a trailId
 * that diverged under a merge; read-only listings disable that repair.
 */
export function allLedgerSessionViews(
  opts: { repairTargets?: boolean } = {},
): LedgerSessionView[] {
  return allLedgerSessions().map((session) => {
    const targets = session.targets ?? [];
    const targetPaths = targets.map((t) => knownTrailPath(t.trailId) ?? t.path);
    let targetMissing = false;
    if (session.status === 'placed' && targets.length > 0) {
      targetMissing = !targets.some((t) =>
        targetAlive(session.id, t, opts.repairTargets !== false),
      );
    }
    return { ...session, targetMissing, targetPaths };
  });
}

// --- records --------------------------------------------------------------

/** Fields a caller provides to append a capture record (id/ts are filled in). */
export type NewLedgerRecord = Omit<LedgerRecord, 'id' | 'ts'> & { ts?: string };

/** Append one capture record to a session and return it (with its minted id). */
export function appendLedgerRecord(id: string, input: NewLedgerRecord): LedgerRecord {
  let diff = input.diff;
  if (diff && Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n… (diff truncated)';
  }
  const record: LedgerRecord = {
    id: makeId(
      input.kind === 'edit' ? 'art' : input.kind === 'conversation_event' ? 'raw' : 'evt',
    ),
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    tool: input.tool,
  };
  if (input.text !== undefined) record.text = input.text;
  if (input.file !== undefined) record.file = input.file;
  if (diff !== undefined) record.diff = diff;
  if (input.deleted) record.deleted = true;
  if (input.turnKey) record.turnKey = input.turnKey;
  if (input.approved !== undefined) record.approved = input.approved;
  if (input.planFileContent !== undefined) record.planFileContent = input.planFileContent;
  if (input.planFileSourceId) record.planFileSourceId = input.planFileSourceId;
  if (input.gitCommit) record.gitCommit = input.gitCommit;
  if (input.sha256) record.sha256 = input.sha256;
  if (input.sourceId) record.sourceId = input.sourceId;
  if (input.supersedesRecordId) record.supersedesRecordId = input.supersedesRecordId;
  if (input.transcriptFinal !== undefined) {
    record.transcriptFinal = input.transcriptFinal;
  }
  if (input.context) {
    record.context = {
      ...(input.context.cwd !== undefined ? { cwd: input.context.cwd } : {}),
      ...(input.context.workspacePaths
        ? { workspacePaths: [...input.context.workspacePaths] }
        : {}),
      ...(input.context.scope ? { scope: input.context.scope } : {}),
    };
  }
  if (input.conversationEvent) record.conversationEvent = input.conversationEvent;
  if (input.toolName) record.toolName = input.toolName;
  if (input.isError) record.isError = input.isError;
  if (input.durationMs !== undefined) record.durationMs = input.durationMs;
  if (input.gitBranch) record.gitBranch = input.gitBranch;
  if (input.inputTokens !== undefined) record.inputTokens = input.inputTokens;
  if (input.outputTokens !== undefined) record.outputTokens = input.outputTokens;
  if (input.cacheReadTokens !== undefined) record.cacheReadTokens = input.cacheReadTokens;
  if (input.cacheCreationTokens !== undefined) {
    record.cacheCreationTokens = input.cacheCreationTokens;
  }
  appendJsonl(recordsFile(id), record);
  return record;
}

/** Read every capture record for a session, in write order. */
export function readLedgerRecords(id: string): LedgerRecord[] {
  return readJsonl<LedgerRecord>(recordsFile(id));
}

// --- turn segments ---------------------------------------------------------

/** Refuse to overwrite a sidecar written by a newer Showtail binary. */
export class UnsupportedLedgerSegmentsVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `Ledger segment data uses schema ${version}; this Showtail supports ${LEDGER_SEGMENTS_VERSION}.`,
    );
    this.name = 'UnsupportedLedgerSegmentsVersionError';
  }
}

function cloneTarget(target: LedgerTarget): LedgerTarget {
  return { trailId: target.trailId, path: target.path };
}

function cloneMigration(
  migration: LedgerSegmentMigration | undefined,
): LedgerSegmentMigration | undefined {
  return migration
    ? {
        ...migration,
        destination: cloneTarget(migration.destination),
        sourceTargets: migration.sourceTargets.map(cloneTarget),
      }
    : undefined;
}

function cloneControlTarget(
  target: LedgerProjectControlTarget | undefined,
): LedgerProjectControlTarget | undefined {
  return target
    ? {
        ...target,
        evidence: [...target.evidence],
      }
    : undefined;
}

function cloneSegment(segment: LedgerSegment): LedgerSegment {
  return {
    ...segment,
    recordIds: [...segment.recordIds],
    ...(segment.attachments
      ? { attachments: segment.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(segment.controlTarget
      ? { controlTarget: cloneControlTarget(segment.controlTarget) }
      : {}),
    ...(segment.targets ? { targets: segment.targets.map(cloneTarget) } : {}),
    ...(segment.pathRebases
      ? { pathRebases: segment.pathRebases.map((rebase) => ({ ...rebase })) }
      : {}),
    ...(segment.migration ? { migration: cloneMigration(segment.migration) } : {}),
  };
}

function segmentIdForPrompt(promptRecordId: string): string {
  return `seg_${promptRecordId}`;
}

const LEADING_SEGMENT_ID = 'seg_unassigned';

/** Stable composite selector accepted by inbox/move/report command surfaces. */
export function ledgerSegmentSelector(sessionId: string, segmentId: string): string {
  return `${sessionId}:${segmentId}`;
}

/** Stable projection source id; corrected records get an auditable revision suffix. */
export function ledgerRecordProjectionSourceId(
  sessionId: string,
  record: LedgerRecord,
): string {
  const base = record.sourceId ?? `ledger:${sessionId}:${record.id}`;
  return record.supersedesRecordId ? `${base}:revision:${record.id}` : base;
}

interface LedgerSupersessionState {
  eligible: Set<string>;
  superseded: Set<string>;
  unresolvedIssues: LedgerSupersessionIssue[];
}

export type LedgerSupersessionIssueReason =
  | 'missing-predecessor'
  | 'predecessor-not-effective'
  | 'predecessor-already-superseded'
  | 'kind-mismatch'
  | 'source-id-mismatch';

/** A malformed correction that remains at the tip of its logical source chain. */
export interface LedgerSupersessionIssue {
  recordId: string;
  supersedesRecordId: string;
  reason: LedgerSupersessionIssueReason;
  kind: LedgerRecord['kind'];
  sourceId?: string;
}

interface PendingLedgerSupersessionIssue extends LedgerSupersessionIssue {
  index: number;
}

function validCorrectionDescendsFrom(
  recordId: string,
  ancestorId: string,
  validParents: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = recordId;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = validParents.get(current);
  }
  return false;
}

/** Validate append-only correction chains and identify their effective leaves. */
function ledgerSupersessionState(
  records: readonly LedgerRecord[],
): LedgerSupersessionState {
  const preceding = new Map<string, LedgerRecord>();
  const eligible = new Set<string>();
  const superseded = new Set<string>();
  const validParents = new Map<string, string>();
  const validCorrectionsByIdentity = new Map<
    string,
    Array<{ recordId: string; index: number }>
  >();
  const pendingIssues: PendingLedgerSupersessionIssue[] = [];
  for (const [index, record] of records.entries()) {
    if (!record.supersedesRecordId) {
      eligible.add(record.id);
      preceding.set(record.id, record);
      continue;
    }
    const target = preceding.get(record.supersedesRecordId);
    let reason: LedgerSupersessionIssueReason | undefined;
    if (!target) reason = 'missing-predecessor';
    else if (record.kind !== target.kind) reason = 'kind-mismatch';
    else if (record.sourceId === undefined || record.sourceId !== target.sourceId) {
      reason = 'source-id-mismatch';
    } else if (!eligible.has(target.id)) reason = 'predecessor-not-effective';
    else if (superseded.has(target.id)) reason = 'predecessor-already-superseded';

    if (!reason && target) {
      eligible.add(record.id);
      superseded.add(target.id);
      validParents.set(record.id, target.id);
      const identity = `${record.kind}\0${record.sourceId}`;
      const validCorrections = validCorrectionsByIdentity.get(identity) ?? [];
      validCorrections.push({ recordId: record.id, index });
      validCorrectionsByIdentity.set(identity, validCorrections);
    } else if (reason) {
      pendingIssues.push({
        recordId: record.id,
        supersedesRecordId: record.supersedesRecordId,
        reason,
        kind: record.kind,
        ...(record.sourceId ? { sourceId: record.sourceId } : {}),
        index,
      });
    }
    preceding.set(record.id, record);
  }

  const unresolvedIssues = pendingIssues
    .filter((issue) => {
      if (!issue.sourceId) return true;
      const validCorrections =
        validCorrectionsByIdentity.get(`${issue.kind}\0${issue.sourceId}`) ?? [];
      return !validCorrections.some(
        (record) =>
          record.index > issue.index &&
          validCorrectionDescendsFrom(
            record.recordId,
            issue.supersedesRecordId,
            validParents,
          ),
      );
    })
    .map(({ index: _index, ...issue }) => issue);
  return { eligible, superseded, unresolvedIssues };
}

/** Raw record ids hidden by a valid later append-only correction. */
export function supersededLedgerRecordIds(records: readonly LedgerRecord[]): Set<string> {
  return ledgerSupersessionState(records).superseded;
}

/** Records that form the current logical transcript after valid corrections. */
export function effectiveLedgerRecords(records: readonly LedgerRecord[]): LedgerRecord[] {
  const { eligible, superseded } = ledgerSupersessionState(records);
  return records.filter(
    (record) => eligible.has(record.id) && !superseded.has(record.id),
  );
}

/** Invalid correction tips that still require an automatic or manual repair. */
export function unresolvedLedgerSupersessionIssues(
  records: readonly LedgerRecord[],
): LedgerSupersessionIssue[] {
  return ledgerSupersessionState(records).unresolvedIssues;
}

/** Copilot embeds its request id in every prompt/reply/edit source id. */
function copilotRequestIdentity(
  sourceId: string | undefined,
): { nativeSessionId: string; nativeRequestId: string; key: string } | undefined {
  if (!sourceId) return undefined;
  let value = sourceId.startsWith('conversation:')
    ? sourceId.slice('conversation:'.length)
    : sourceId;
  const fragment = value.indexOf('#');
  if (fragment >= 0) value = value.slice(0, fragment);
  const parts = value.split(':');
  if (
    parts.length < 4 ||
    parts[0] !== 'copilot' ||
    !['user', 'asst', 'edit', 'plan'].includes(parts[1] ?? '')
  ) {
    return undefined;
  }
  const requestId = parts.at(-1);
  const nativeSessionId = parts.slice(2, -1).join(':');
  return requestId && nativeSessionId
    ? {
        nativeSessionId,
        nativeRequestId: requestId,
        key: `${nativeSessionId}\t${requestId}`,
      }
    : undefined;
}

interface LoadedLedgerSegments {
  document: LedgerSegmentsDocument;
  persistedVersion: number;
}

function loadSegmentsDocument(id: string): LoadedLedgerSegments | null {
  const file = segmentsFile(id);
  if (!existsSync(file)) return null;
  let raw: Omit<Partial<LedgerSegmentsDocument>, 'version'> & { version?: number };
  try {
    raw = readJson<
      Omit<Partial<LedgerSegmentsDocument>, 'version'> & { version?: number }
    >(file);
  } catch {
    return null;
  }
  if (typeof raw.version === 'number' && raw.version > LEDGER_SEGMENTS_VERSION) {
    throw new UnsupportedLedgerSegmentsVersionError(raw.version);
  }
  if (
    (raw.version !== 1 && raw.version !== LEDGER_SEGMENTS_VERSION) ||
    typeof raw.recordCount !== 'number' ||
    !Array.isArray(raw.segments)
  ) {
    return null;
  }
  return {
    document: {
      ...(raw as LedgerSegmentsDocument),
      version: LEDGER_SEGMENTS_VERSION,
    },
    persistedVersion: raw.version,
  };
}

function readSegmentsDocument(id: string): LedgerSegmentsDocument | null {
  return loadSegmentsDocument(id)?.document ?? null;
}

/** Read the persisted sidecar without deriving it. Primarily useful for diagnostics. */
export function readPersistedLedgerSegments(
  sessionId: string,
): LedgerSegmentsDocument | null {
  const document = readSegmentsDocument(sessionId);
  return document ? { ...document, segments: document.segments.map(cloneSegment) } : null;
}

function segmentMetadata(
  session: LedgerSession,
  prior: LedgerSegment | undefined,
  legacy: boolean,
): Pick<
  LedgerSegment,
  | 'status'
  | 'targets'
  | 'dismissedAt'
  | 'pathRebases'
  | 'migration'
  | 'nativeRequestId'
  | 'attachments'
  | 'controlTarget'
> {
  const status = prior?.status ?? (legacy ? session.status : 'inbox');
  const targets = prior?.targets ?? (legacy ? session.targets : undefined);
  const dismissedAt = prior?.dismissedAt ?? (legacy ? session.dismissedAt : undefined);
  const pathRebases = prior?.pathRebases ?? (legacy ? session.pathRebases : undefined);
  return {
    status,
    ...(targets ? { targets: targets.map(cloneTarget) } : {}),
    ...(dismissedAt ? { dismissedAt } : {}),
    ...(pathRebases ? { pathRebases: pathRebases.map((rebase) => ({ ...rebase })) } : {}),
    ...(prior?.migration ? { migration: cloneMigration(prior.migration) } : {}),
    ...(prior?.nativeRequestId ? { nativeRequestId: prior.nativeRequestId } : {}),
    ...(prior?.attachments
      ? { attachments: prior.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(prior?.controlTarget
      ? { controlTarget: cloneControlTarget(prior.controlTarget) }
      : {}),
  };
}

/** Derive prompt turns while preserving placement metadata from an older sidecar. */
function deriveLedgerSegments(
  session: LedgerSession,
  records: LedgerRecord[],
  prior: LedgerSegmentsDocument | null,
): LedgerSegmentsDocument {
  const priorById = new Map(
    (prior?.segments ?? []).map((segment) => [segment.id, segment]),
  );
  const legacy = prior === null;
  const segments = new Map<string, LedgerSegment>();
  const promptSegmentByRecordId = new Map<string, string>();
  const promptSegmentByCopilotRequest = new Map<string, string>();

  for (const record of records) {
    if (record.kind !== 'prompt') continue;
    const id = segmentIdForPrompt(record.id);
    const priorSegment = priorById.get(id);
    const segment: LedgerSegment = {
      id,
      promptRecordId: record.id,
      recordIds: [],
      startedAt: record.ts,
      endedAt: record.ts,
      ...segmentMetadata(session, priorSegment, legacy),
    };
    const request = copilotRequestIdentity(record.sourceId);
    if (request?.nativeSessionId === session.nativeSessionId) {
      if (
        (priorSegment?.nativeRequestId &&
          priorSegment.nativeRequestId !== request.nativeRequestId) ||
        (segment.controlTarget &&
          (segment.controlTarget.nativeSessionId !== request.nativeSessionId ||
            segment.controlTarget.nativeRequestId !== request.nativeRequestId))
      ) {
        delete segment.attachments;
        delete segment.controlTarget;
      }
      segment.nativeRequestId = request.nativeRequestId;
    }
    segments.set(id, segment);
    promptSegmentByRecordId.set(record.id, id);
    if (request) promptSegmentByCopilotRequest.set(request.key, id);
  }

  let currentSegmentId: string | undefined;
  for (const record of records) {
    let segmentId: string | undefined;
    if (record.kind === 'prompt') {
      segmentId = promptSegmentByRecordId.get(record.id);
      currentSegmentId = segmentId;
    } else if (record.turnKey) {
      segmentId = promptSegmentByRecordId.get(record.turnKey);
    } else {
      const request = copilotRequestIdentity(record.sourceId);
      segmentId = request
        ? promptSegmentByCopilotRequest.get(request.key)
        : currentSegmentId;
    }

    if (!segmentId) {
      segmentId = LEADING_SEGMENT_ID;
      if (!segments.has(segmentId)) {
        segments.set(segmentId, {
          id: segmentId,
          recordIds: [],
          startedAt: record.ts,
          endedAt: record.ts,
          ...segmentMetadata(session, priorById.get(segmentId), legacy),
        });
      }
    }
    const segment = segments.get(segmentId)!;
    segment.recordIds.push(record.id);
    if (record.ts < segment.startedAt) segment.startedAt = record.ts;
    if (record.ts > segment.endedAt) segment.endedAt = record.ts;
  }

  if (prior) {
    for (const segment of segments.values()) {
      if (priorById.has(segment.id)) continue;
      const ids = new Set(segment.recordIds);
      const predecessor = prior.segments
        .map((candidate) => ({
          candidate,
          overlap: candidate.recordIds.reduce(
            (count, recordId) => count + Number(ids.has(recordId)),
            0,
          ),
        }))
        .sort((a, b) => b.overlap - a.overlap)[0];
      if (!predecessor || predecessor.overlap === 0) continue;
      Object.assign(segment, segmentMetadata(session, predecessor.candidate, false));
    }
  }

  const ordered = [...segments.values()]
    .filter((segment) => segment.recordIds.length > 0)
    .sort((a, b) => {
      const firstA = records.findIndex((record) => record.id === a.recordIds[0]);
      const firstB = records.findIndex((record) => record.id === b.recordIds[0]);
      return firstA - firstB;
    });
  return {
    version: LEDGER_SEGMENTS_VERSION,
    recordCount: records.length,
    ...(records.at(-1) ? { lastRecordId: records.at(-1)!.id } : {}),
    segments: ordered,
  };
}

function segmentsCurrent(
  document: LedgerSegmentsDocument,
  records: LedgerRecord[],
): boolean {
  return (
    document.recordCount === records.length &&
    document.lastRecordId === records.at(-1)?.id
  );
}

/**
 * Read or lazily derive the versioned turn sidecar. Raw records are never
 * rewritten; a late transcript append simply refreshes segment membership.
 */
export function ensureLedgerSegments(
  sessionOrId: LedgerSession | string,
  opts: { continueCapture?: () => boolean; persist?: boolean } = {},
): LedgerSegmentsDocument {
  requireCaptureContinuation(opts.continueCapture);
  const session =
    typeof sessionOrId === 'string' ? readLedgerSession(sessionOrId) : sessionOrId;
  if (!session) {
    return { version: LEDGER_SEGMENTS_VERSION, recordCount: 0, segments: [] };
  }
  const records = readLedgerRecords(session.id);
  const loaded = loadSegmentsDocument(session.id);
  const persisted = loaded?.document ?? null;
  if (
    persisted &&
    loaded?.persistedVersion === LEDGER_SEGMENTS_VERSION &&
    segmentsCurrent(persisted, records)
  ) {
    return { ...persisted, segments: persisted.segments.map(cloneSegment) };
  }

  // Re-read immediately before the atomic replace so a concurrent placement is
  // merged into the fresh derivation rather than clobbered by a stale snapshot.
  requireCaptureContinuation(opts.continueCapture);
  const latest = loadSegmentsDocument(session.id)?.document ?? persisted;
  const derived = deriveLedgerSegments(session, records, latest);
  if (opts.persist === false) {
    return { ...derived, segments: derived.segments.map(cloneSegment) };
  }
  requireCaptureContinuation(opts.continueCapture);
  writeJson(segmentsFile(session.id), derived);
  return { ...derived, segments: derived.segments.map(cloneSegment) };
}

function writeLedgerSegments(
  sessionId: string,
  document: LedgerSegmentsDocument,
  continueCapture?: () => boolean,
): void {
  requireCaptureContinuation(continueCapture);
  writeJson(segmentsFile(sessionId), document);
}

/** Records belonging to one segment, preserving immutable ledger order. */
export function readLedgerSegmentRecords(
  sessionId: string,
  segmentOrId: LedgerSegment | string,
): LedgerRecord[] {
  const segment =
    typeof segmentOrId === 'string'
      ? ensureLedgerSegments(sessionId).segments.find((item) => item.id === segmentOrId)
      : segmentOrId;
  if (!segment) return [];
  const wanted = new Set(segment.recordIds);
  return readLedgerRecords(sessionId).filter((record) => wanted.has(record.id));
}

/** Resolve a capture-time path through only this turn's project moves. */
export function effectiveLedgerSegmentPath(
  segment: LedgerSegment,
  path: string,
  additionalRebase?: PathRebase,
): string {
  const effective = applyPathRebases(segment.pathRebases, path);
  const previous = segment.pathRebases?.at(-1);
  if (additionalRebase && (!previous || !samePathRebase(previous, additionalRebase))) {
    return applyPathRebases([additionalRebase], effective);
  }
  return effective;
}

export interface LedgerTurnProjectMetadataInput {
  nativeRequestId?: string;
  attachments?: LedgerProjectAttachment[];
  controlTarget?: LedgerProjectControlInput;
  /** Prefer the native request timestamp; falls back to capture time. */
  observedAt?: string;
  continueCapture?: () => boolean;
}

function validControlInput(control: LedgerProjectControlInput): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      control.claimId,
    ) &&
    ['report', 'open_report', 'status', 'verify'].includes(control.action) &&
    /^trl_[A-Za-z0-9_-]+$/.test(control.trailId) &&
    isAbsolute(control.root) &&
    (control.mode === 'authoritative' || control.mode === 'corroborated') &&
    Array.isArray(control.evidence) &&
    control.evidence.length > 0 &&
    control.evidence.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 80 &&
        !/[\r\n]/.test(item),
    ) &&
    (control.reportPath === undefined || isAbsolute(control.reportPath))
  );
}

/**
 * Associate trusted transcript metadata with the exact prompt segment. Re-reading
 * an append-only native transcript is idempotent; one claim cannot be replayed
 * onto a different request in the same session.
 */
export function setLedgerTurnProjectMetadata(
  sessionId: string,
  promptRecordId: string,
  input: LedgerTurnProjectMetadataInput,
): boolean {
  requireCaptureContinuation(input.continueCapture);
  const session = readLedgerSession(sessionId);
  if (!session) return false;
  const document = ensureLedgerSegments(session, {
    continueCapture: input.continueCapture,
  });
  const segment = document.segments.find(
    (item) => item.promptRecordId === promptRecordId,
  );
  if (!segment) return false;

  let changed = false;
  const nativeRequestId = input.nativeRequestId?.trim();
  if (
    nativeRequestId &&
    segment.nativeRequestId &&
    segment.nativeRequestId !== nativeRequestId
  ) {
    return false;
  }
  if (nativeRequestId && !segment.nativeRequestId) {
    segment.nativeRequestId = nativeRequestId;
    changed = true;
  }

  if (input.attachments && input.attachments.length > 0) {
    const attachments = new Map<string, LedgerProjectAttachment>();
    for (const attachment of [...(segment.attachments ?? []), ...input.attachments]) {
      if (
        (attachment.kind !== 'file' && attachment.kind !== 'folder') ||
        !isAbsolute(attachment.path)
      ) {
        continue;
      }
      const path = resolve(attachment.path);
      attachments.set(`${attachment.kind}\t${pathKey(path)}`, {
        kind: attachment.kind,
        path,
      });
    }
    const next = [...attachments.values()];
    if (JSON.stringify(next) !== JSON.stringify(segment.attachments ?? [])) {
      segment.attachments = next;
      changed = true;
    }
  }

  const control = input.controlTarget;
  if (control && nativeRequestId && validControlInput(control)) {
    const replayedElsewhere = document.segments.some(
      (item) => item.id !== segment.id && item.controlTarget?.claimId === control.claimId,
    );
    if (!replayedElsewhere) {
      const observedAt = input.observedAt;
      const boundAt =
        observedAt && Number.isFinite(Date.parse(observedAt))
          ? new Date(observedAt).toISOString()
          : new Date().toISOString();
      const target: LedgerProjectControlTarget = {
        schemaVersion: LEDGER_PROJECT_BINDING_VERSION,
        source: 'showtail-project-control',
        nativeSessionId: session.nativeSessionId,
        nativeRequestId,
        claimId: control.claimId,
        action: control.action,
        trailId: control.trailId,
        root: resolve(control.root),
        ...(control.displayName ? { displayName: control.displayName } : {}),
        mode: control.mode,
        evidence: [...new Set(control.evidence)],
        ...(control.crossWorkspace === undefined
          ? {}
          : { crossWorkspace: control.crossWorkspace }),
        ...(control.reportPath ? { reportPath: resolve(control.reportPath) } : {}),
        boundAt,
      };
      if (JSON.stringify(target) !== JSON.stringify(segment.controlTarget)) {
        segment.controlTarget = target;
        changed = true;
      }
    }
  }

  if (!changed) return true;
  requireCaptureContinuation(input.continueCapture);
  writeLedgerSegments(sessionId, document, input.continueCapture);
  return true;
}

function segmentRecordContext(records: LedgerRecord[]): LedgerRecord['context'] {
  return records.find((record) => record.context !== undefined)?.context;
}

const TERMINAL_TOOL_NAMES = new Set([
  'bash',
  'cmd',
  'exec',
  'exec_command',
  'execute_command',
  'powershell',
  'run_command',
  'run_in_terminal',
  'shell',
  'shell_command',
  'terminal',
]);

const FILE_MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'create',
  'create_file',
  'create_new_file',
  'edit',
  'edit_file',
  'insert_edit_into_file',
  'multi_replace_string_in_file',
  'patch_file',
  'replace',
  'replace_in_file',
  'replace_string_in_file',
  'str_replace',
  'str_replace_editor',
  'write',
  'write_file',
  'write_to_file',
]);

const RELOCATION_TOOL_NAMES = new Set([
  'copy',
  'copy_file',
  'move',
  'move_file',
  'rename',
  'rename_file',
]);

const FILE_MUTATION_PATH_FIELDS = new Set([
  'absolutepath',
  'destination',
  'destinationpath',
  'file',
  'filepath',
  'filepaths',
  'files',
  'fspath',
  'fullpath',
  'outputpath',
  'path',
  'paths',
  'target',
  'targetpath',
  'uri',
]);

// A relocation's generic `path`/`source` fields normally name the old location.
// Only destination-shaped fields can prove where the durable result now lives.
const RELOCATION_TARGET_PATH_FIELDS = new Set([
  'dest',
  'destination',
  'destinationpath',
  'newfilepath',
  'newpath',
  'outputpath',
  'target',
  'targetpath',
  'to',
  'topath',
]);

const TOOL_INTERNAL_PATH_RE =
  /(^|[\\/])\.(?:agents|aider|antigravity-ide|claude|codex|copilot|gemini|showtail|showtail-cli)([\\/]|$)/i;

function normalizedToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toolNameMatches(name: string, candidates: ReadonlySet<string>): boolean {
  const normalized = normalizedToolName(name);
  for (const candidate of candidates) {
    if (normalized === candidate || normalized.endsWith(`_${candidate}`)) return true;
  }
  return false;
}

function isTerminalToolUse(event: ConversationEvent, toolName: string): boolean {
  if (toolNameMatches(toolName, TERMINAL_TOOL_NAMES)) return true;
  if (!event.input || typeof event.input !== 'object' || Array.isArray(event.input)) {
    return false;
  }
  const input = event.input as Record<string, unknown>;
  return typeof input.command === 'string' || typeof input.cmd === 'string';
}

function mutationPathFields(toolName: string): ReadonlySet<string> | null {
  if (toolNameMatches(toolName, RELOCATION_TOOL_NAMES)) {
    return RELOCATION_TARGET_PATH_FIELDS;
  }
  return toolNameMatches(toolName, FILE_MUTATION_TOOL_NAMES)
    ? FILE_MUTATION_PATH_FIELDS
    : null;
}

function appendAbsolutePath(paths: string[], candidate: string): void {
  const value = candidate.trim().replace(/[),.;]+$/, '');
  if (!isAbsolute(value)) return;
  const resolved = resolve(value);
  if (!paths.some((path) => pathKey(path) === pathKey(resolved))) paths.push(resolved);
}

function collectPathFields(
  value: unknown,
  paths: string[],
  fields: ReadonlySet<string>,
  pathField = false,
): void {
  if (typeof value === 'string') {
    if (pathField) appendAbsolutePath(paths, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathFields(item, paths, fields, pathField);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    collectPathFields(item, paths, fields, pathField || fields.has(normalized));
  }
}

function structuredToolResultFailed(value: unknown, depth = 0): boolean {
  if (depth > 2 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => structuredToolResultFailed(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.isError === true || result.is_error === true) return true;
  if (result.success === false || result.ok === false) return true;
  for (const key of ['exitCode', 'exit_code']) {
    const code = result[key];
    if (typeof code === 'number' && code !== 0) return true;
  }
  const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
  if (
    ['cancelled', 'canceled', 'error', 'errored', 'failed', 'failure'].includes(status)
  ) {
    return true;
  }
  const error = result.error;
  if (error !== undefined && error !== null && error !== false && error !== '')
    return true;
  return ['metadata', 'result'].some((key) =>
    structuredToolResultFailed(result[key], depth + 1),
  );
}

function successfulToolResult(event: ConversationEvent): boolean {
  return (
    event.type === 'tool_result' &&
    event.isError !== true &&
    (event.exitCode === undefined || event.exitCode === 0) &&
    !structuredToolResultFailed(event.content)
  );
}

/**
 * Per-turn routing evidence from a completed filesystem mutation. Read/search
 * inputs and terminal command/output paths are intentionally excluded: those are
 * model-authored or control-plane observations, not proof that student work lives
 * there. A mutation must have a correlated successful result and a target that
 * still exists after applying this turn's path rebases.
 */
function toolProjectContext(
  records: LedgerRecord[],
  segment: LedgerSegment,
): LedgerSegmentProjectContext | null {
  const paths: string[] = [];
  const toolUses = new Map<string, ConversationEvent>();
  for (const record of records) {
    const event = record.conversationEvent;
    if (event?.type === 'tool_use' && event.toolUseId) {
      toolUses.set(event.toolUseId, event);
    }
  }
  for (const record of records) {
    const result = record.conversationEvent;
    if (!result?.toolUseId || !successfulToolResult(result)) continue;
    const use = toolUses.get(result.toolUseId);
    if (!use || typeof use.toolName !== 'string') continue;
    if (isTerminalToolUse(use, use.toolName)) continue;
    const fields = mutationPathFields(use.toolName);
    if (!fields) continue;
    collectPathFields(use.input, paths, fields);
    collectPathFields(result.content, paths, fields);
  }
  if (paths.length === 0) return null;
  const existing = paths
    .map((path) => effectiveLedgerSegmentPath(segment, path))
    .filter((path) => existsSync(path) && !TOOL_INTERNAL_PATH_RE.test(path));
  if (existing.length === 0) return null;
  const workspacePaths = existing.filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  const context = resolveProjectContext({
    cwd: null,
    editPaths: existing.filter(
      (path) => !workspacePaths.some((workspace) => pathKey(workspace) === pathKey(path)),
    ),
    workspacePaths,
  });
  return context.state === 'tracked' || context.state === 'candidate'
    ? { ...context, evidence: 'tool' }
    : context;
}

function attachmentProjectContext(
  attachments: readonly LedgerProjectAttachment[],
): LedgerSegmentProjectContext {
  const context = resolveProjectContext({
    cwd: null,
    editPaths: attachments
      .filter((attachment) => attachment.kind === 'file')
      .map((attachment) => attachment.path),
    workspacePaths: attachments
      .filter((attachment) => attachment.kind === 'folder')
      .map((attachment) => attachment.path),
  });
  return context.state === 'tracked' || context.state === 'candidate'
    ? { ...context, evidence: 'attachment' }
    : context;
}

function controlTargetProjectContext(
  target: LedgerProjectControlTarget,
): LedgerSegmentProjectContext {
  const live = new Map<string, string>();
  for (const path of [knownTrailPath(target.trailId), target.root]) {
    if (!path) continue;
    const root = resolve(path);
    if (trailExistsAt(root, target.trailId)) live.set(pathKey(root), root);
  }
  const roots = [...live.values()];
  if (roots.length === 1) {
    return { state: 'tracked', root: roots[0]!, evidence: 'control' };
  }
  return roots.length > 1
    ? { state: 'ambiguous', root: null, evidence: null, candidates: roots }
    : { state: 'none', root: null, evidence: null, candidates: [] };
}

export function isNativeEditorSession(session: LedgerSession): boolean {
  return session.tool === 'github-copilot' || session.tool === 'antigravity-ide';
}

/** Compute every turn's independent route, including no-edit inheritance. */
export function ledgerSegmentProjectContexts(
  session: LedgerSession,
  document: LedgerSegmentsDocument = ensureLedgerSegments(session),
): Map<string, LedgerSegmentProjectContext> {
  const allRecords = readLedgerRecords(session.id);
  // Segments retain the append-only raw ids for audit/rebuild purposes. Routing,
  // however, must see only the current leaves of valid correction chains or a
  // superseded record can keep influencing the turn it was repaired away from.
  const byId = new Map(
    effectiveLedgerRecords(allRecords).map((record) => [record.id, record]),
  );
  const contexts = new Map<string, LedgerSegmentProjectContext>();
  let preceding: LedgerSegmentProjectContext | undefined;
  let precedingSegmentId: string | undefined;
  let precedingTrusted = false;

  for (const segment of document.segments) {
    const records = segment.recordIds.flatMap((id) => {
      const record = byId.get(id);
      return record ? [record] : [];
    });
    const contextHint = segmentRecordContext(records);
    const toolContext = toolProjectContext(records, segment);
    const editPaths = records.flatMap((record) =>
      record.kind === 'edit' && record.file
        ? [effectiveLedgerSegmentPath(segment, record.file)]
        : [],
    );
    let context: LedgerSegmentProjectContext;
    let trusted = false;
    if (editPaths.length > 0) {
      // Edits are direct work evidence. Do not let a stale terminal/workspace
      // hint drag them to another project. The session cwd is used only as a
      // containing anchor so one unmarked `project/src/file` edit does not invent
      // a nested `src` project; an edit outside that cwd still resolves itself.
      context = resolveProjectContext({
        cwd:
          typeof session.cwd === 'string'
            ? effectiveLedgerSegmentPath(segment, session.cwd)
            : null,
        editPaths,
      });
      trusted = context.state === 'tracked' || context.state === 'candidate';
    } else if (segment.attachments && segment.attachments.length > 0) {
      context = attachmentProjectContext(segment.attachments);
      trusted = context.state === 'tracked' || context.state === 'candidate';
    } else if (segment.controlTarget) {
      context = controlTargetProjectContext(segment.controlTarget);
      trusted = context.state === 'tracked' || context.state === 'candidate';
    } else if (toolContext && toolContext.state !== 'none') {
      context = toolContext;
      trusted = context.state === 'tracked' || context.state === 'candidate';
    } else if (
      contextHint?.scope === 'turn' &&
      contextHint.cwd === null &&
      (!contextHint.workspacePaths || contextHint.workspacePaths.length === 0)
    ) {
      // An explicit empty-window transition ends trusted focus. A path-bearing
      // workspace/cwd hint remains ambient and cannot override real work evidence.
      context = { state: 'none', root: null, evidence: null, candidates: [] };
    } else if (
      precedingTrusted &&
      (preceding?.state === 'tracked' || preceding?.state === 'candidate')
    ) {
      context = {
        state: preceding.state,
        root: preceding.root,
        evidence: preceding.evidence,
        ...(precedingSegmentId ? { inheritedFrom: precedingSegmentId } : {}),
      };
      trusted = true;
    } else if (contextHint !== undefined && !isNativeEditorSession(session)) {
      // Non-editor integrations retain their legacy context fallback, but that
      // ambient route is never inherited by a later zero-edit turn.
      context = resolveProjectContext({
        cwd: contextHint.cwd ?? null,
        workspacePaths: contextHint.workspacePaths?.map((path) =>
          effectiveLedgerSegmentPath(segment, path),
        ),
      });
    } else {
      context = { state: 'none', root: null, evidence: null, candidates: [] };
    }
    contexts.set(segment.id, context);
    preceding = context;
    precedingSegmentId = segment.id;
    precedingTrusted = trusted;
  }
  return contexts;
}

/** Resolve one segment's route in the context of the turns before it. */
export function ledgerSegmentProjectContext(
  session: LedgerSession,
  segmentOrId: LedgerSegment | string,
): LedgerSegmentProjectContext {
  const segmentId = typeof segmentOrId === 'string' ? segmentOrId : segmentOrId.id;
  return (
    ledgerSegmentProjectContexts(session).get(segmentId) ?? {
      state: 'none',
      root: null,
      evidence: null,
      candidates: [],
    }
  );
}

function segmentFacts(
  sessionId: string,
  segment: LedgerSegment,
): { prompts: number; edits: number; firstPrompt?: string; editPaths: string[] } {
  let prompts = 0;
  let edits = 0;
  let firstPrompt: string | undefined;
  const editPaths: string[] = [];
  const wanted = new Set(segment.recordIds);
  // Resolve corrections across the whole session before selecting this segment:
  // a corrected record can move from one turn to another while raw membership
  // remains append-only in both segments for audit and deterministic rebuilds.
  for (const record of effectiveLedgerRecords(readLedgerRecords(sessionId))) {
    if (!wanted.has(record.id)) continue;
    if (record.kind === 'prompt') {
      prompts += 1;
      if (!firstPrompt && record.text) firstPrompt = record.text;
    } else if (record.kind === 'edit') {
      edits += 1;
      if (record.file) editPaths.push(effectiveLedgerSegmentPath(segment, record.file));
    }
  }
  return { prompts, edits, firstPrompt, editPaths };
}

function segmentHiddenReason(
  segment: LedgerSegment,
  route: LedgerSegmentProjectContext,
  facts: ReturnType<typeof segmentFacts>,
  hasProjectWitness: boolean,
): HiddenReason | null {
  if (segment.dismissedAt) return 'dismissed';
  const pathsGone =
    facts.editPaths.length > 0 &&
    facts.editPaths.every((path) => !existsSync(path)) &&
    facts.editPaths.some((path) => !existsSync(dirname(path)));
  const unresolvedProjectCompanion =
    route.state === 'none' && hasProjectWitness && (facts.prompts > 0 || facts.edits > 0);
  if (route.state === 'none' && !pathsGone && !unresolvedProjectCompanion) {
    return 'not-in-project';
  }
  // A context-free turn beside resolved project work needs human placement even
  // when it is individually small. Otherwise the opening or closing turn of a
  // mixed native chat disappears from the default inbox as low-signal scratch.
  const min = readInboxMinSignal();
  if (
    !unresolvedProjectCompanion &&
    !(facts.edits >= min.edits || facts.prompts >= min.prompts)
  ) {
    return 'low-signal';
  }
  const routePaths =
    route.state === 'tracked' || route.state === 'candidate'
      ? [route.root]
      : route.state === 'ambiguous'
        ? route.candidates
        : facts.editPaths;
  const scratch = readScratchPaths();
  if (scratch.some((root) => routePaths.some((path) => isPathUnder(path, root)))) {
    return 'ignored-path';
  }
  return null;
}

function segmentTargetAlive(target: LedgerTarget): boolean {
  const path = knownTrailPath(target.trailId) ?? target.path;
  return trailIdAt(path) !== undefined;
}

/** List routeable turn ranges with composite selectors for command surfaces. */
export function listLedgerSegmentViews(
  opts: {
    includeHidden?: boolean;
    pendingOnly?: boolean;
    sessionId?: string;
    /** Read-only probes derive stale/missing sidecars in memory only. */
    persist?: boolean;
  } = {},
): LedgerSegmentView[] {
  const views: LedgerSegmentView[] = [];
  for (const session of allLedgerSessions()) {
    if (opts.sessionId && session.id !== opts.sessionId) continue;
    const document = ensureLedgerSegments(session, { persist: opts.persist });
    const contexts = ledgerSegmentProjectContexts(session, document);
    const ignoredRoots = readScratchPaths();
    const isIgnoredWitness = (path: string): boolean =>
      ignoredRoots.some((root) => isPathUnder(path, root));
    const hasProjectWitness = document.segments.some((segment) => {
      const context = contexts.get(segment.id);
      const witnessPaths = (segment.targets ?? []).map(
        (target) => knownTrailPath(target.trailId) ?? target.path,
      );
      if (context?.state === 'tracked' || context?.state === 'candidate') {
        witnessPaths.push(context.root);
      }
      return witnessPaths.some((path) => !isIgnoredWitness(path));
    });
    for (const segment of document.segments) {
      const facts = segmentFacts(session.id, segment);
      const route = contexts.get(segment.id)!;
      const targets = segment.targets ?? [];
      const targetPaths = targets.map(
        (target) => knownTrailPath(target.trailId) ?? target.path,
      );
      const targetMissing =
        segment.status === 'placed' &&
        targets.length > 0 &&
        !targets.some(segmentTargetAlive);
      const hiddenReason = segmentHiddenReason(segment, route, facts, hasProjectWitness);
      if (!opts.includeHidden && hiddenReason !== null && !targetMissing) continue;
      if (opts.pendingOnly && segment.status === 'placed' && !targetMissing) continue;
      views.push({
        selector: ledgerSegmentSelector(session.id, segment.id),
        session,
        segment,
        route,
        targetMissing,
        targetPaths,
        prompts: facts.prompts,
        edits: facts.edits,
        ...(facts.firstPrompt ? { firstPrompt: facts.firstPrompt } : {}),
        hiddenReason,
      });
    }
  }
  return views.sort((a, b) => b.segment.endedAt.localeCompare(a.segment.endedAt));
}

/**
 * Lazily derived routing changes for legacy or late-growing sessions. A
 * deterministic turn is returned when none of its recorded targets matches its
 * current route; an edit-bearing ambiguous turn is returned while still placed.
 */
export function listLedgerSegmentsNeedingReprojection(
  opts: { sessionId?: string; persist?: boolean } = {},
): LedgerSegmentView[] {
  return listLedgerSegmentViews({
    includeHidden: true,
    sessionId: opts.sessionId,
    persist: opts.persist,
  }).filter((view) => {
    const targets = view.targetPaths;
    if (targets.length === 0) return false;
    if (view.route.state === 'ambiguous') return true;
    if (view.route.state === 'none') return false;
    const routedRoot = view.route.root;
    return !targets.some(
      (target) => pathKey(resolve(target)) === pathKey(resolve(routedRoot)),
    );
  });
}

function pendingSegmentView(view: LedgerSegmentView): boolean {
  return view.segment.status === 'inbox' || view.targetMissing;
}

function unresolvedRangeKey(view: LedgerSegmentView): string | null {
  if (!pendingSegmentView(view)) return null;
  if (view.route.state === 'none') return `none:${view.hiddenReason ?? 'pending'}`;
  if (view.route.state === 'ambiguous' && view.edits === 0) {
    return `ambiguous:${view.route.candidates
      .map((candidate) => pathKey(candidate))
      .sort()
      .join('|')}:${view.hiddenReason ?? 'pending'}`;
  }
  // A turn that itself edits A+B is never merged with its neighbors.
  return null;
}

function asRange(members: LedgerSegmentView[]): LedgerRangeView {
  const first = members[0]!;
  const targetPaths = [
    ...new Map(
      members.flatMap((member) =>
        member.targetPaths.map((path) => [pathKey(path), path] as const),
      ),
    ).values(),
  ];
  return {
    ...first,
    memberSegmentIds: members.map((member) => member.segment.id),
    segments: members.map((member) => cloneSegment(member.segment)),
    targetMissing: members.some((member) => member.targetMissing),
    targetPaths,
    prompts: members.reduce((count, member) => count + member.prompts, 0),
    edits: members.reduce((count, member) => count + member.edits, 0),
    firstPrompt: members.find((member) => member.firstPrompt)?.firstPrompt,
  };
}

/**
 * List command-level ranges. Consecutive unresolved pending turns from one
 * native chat collapse into one stable selector, while storage/projection stays
 * per segment and edit-bearing multi-root turns remain atomic.
 */
export function listActionableLedgerRanges(
  opts: Parameters<typeof listLedgerSegmentViews>[0] = {},
): LedgerRangeView[] {
  const all = listLedgerSegmentViews({
    includeHidden: true,
    sessionId: opts.sessionId,
    persist: opts.persist,
  });
  const viewsBySession = new Map<string, Map<string, LedgerSegmentView>>();
  for (const view of all) {
    const bySegment = viewsBySession.get(view.session.id) ?? new Map();
    bySegment.set(view.segment.id, view);
    viewsBySession.set(view.session.id, bySegment);
  }

  const ranges: LedgerRangeView[] = [];
  for (const session of allLedgerSessions()) {
    if (opts.sessionId && session.id !== opts.sessionId) continue;
    const bySegment = viewsBySession.get(session.id);
    if (!bySegment) continue;
    let pendingGroup: LedgerSegmentView[] = [];
    let pendingKey: string | null = null;
    const flush = (): void => {
      if (pendingGroup.length > 0) ranges.push(asRange(pendingGroup));
      pendingGroup = [];
      pendingKey = null;
    };
    for (const segment of ensureLedgerSegments(session, { persist: opts.persist })
      .segments) {
      const view = bySegment.get(segment.id);
      if (!view) continue;
      const key = unresolvedRangeKey(view);
      if (key && key === pendingKey) {
        pendingGroup.push(view);
      } else {
        flush();
        if (key) {
          pendingGroup = [view];
          pendingKey = key;
        } else {
          ranges.push(asRange([view]));
        }
      }
    }
    flush();
  }

  return ranges
    .filter(
      (range) =>
        (opts.includeHidden || range.hiddenReason === null || range.targetMissing) &&
        (!opts.pendingOnly || pendingSegmentView(range)),
    )
    .sort((a, b) => b.segment.endedAt.localeCompare(a.segment.endedAt));
}

/** Resolve `led_…:seg_…`, or a unique prefix of both halves. */
export function resolveLedgerSegmentSelector(selector: string): LedgerSegmentView | null {
  const views = listLedgerSegmentViews({ includeHidden: true });
  const exact = views.find((view) => view.selector === selector);
  if (exact) return exact;

  const colon = selector.indexOf(':');
  if (colon >= 0) {
    const sessionPrefix = selector.slice(0, colon);
    const segmentPrefix = selector.slice(colon + 1);
    const matches = views.filter(
      (view) =>
        view.session.id.startsWith(sessionPrefix) &&
        view.segment.id.startsWith(segmentPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  const matches = views.filter(
    (view) =>
      view.selector.startsWith(selector) ||
      view.segment.id.startsWith(selector) ||
      (view.session.id.startsWith(selector) &&
        ensureLedgerSegments(view.session).segments.length === 1),
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** Resolve a stable range selector or any unambiguous member-segment prefix. */
export function resolveLedgerRangeSelector(selector: string): LedgerRangeView | null {
  const ranges = listActionableLedgerRanges({ includeHidden: true });
  const exact = ranges.find(
    (range) =>
      range.selector === selector ||
      range.memberSegmentIds.some(
        (segmentId) =>
          segmentId === selector ||
          ledgerSegmentSelector(range.session.id, segmentId) === selector,
      ),
  );
  if (exact) return exact;

  const colon = selector.indexOf(':');
  const matches = ranges.filter((range) => {
    if (colon >= 0) {
      const sessionPrefix = selector.slice(0, colon);
      const segmentPrefix = selector.slice(colon + 1);
      return (
        range.session.id.startsWith(sessionPrefix) &&
        range.memberSegmentIds.some((id) => id.startsWith(segmentPrefix))
      );
    }
    return (
      range.selector.startsWith(selector) ||
      range.memberSegmentIds.some((id) => id.startsWith(selector)) ||
      (range.session.id.startsWith(selector) &&
        ranges.filter((item) => item.session.id === range.session.id).length === 1)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function updateLedgerSegment(
  sessionId: string,
  segmentId: string,
  mutate: (segment: LedgerSegment) => void,
  continueCapture?: () => boolean,
): LedgerSegmentsDocument | null {
  requireCaptureContinuation(continueCapture);
  const session = readLedgerSession(sessionId);
  if (!session) return null;
  const document = ensureLedgerSegments(session, { continueCapture });
  const segment = document.segments.find((item) => item.id === segmentId);
  if (!segment) return null;
  mutate(segment);
  requireCaptureContinuation(continueCapture);
  writeLedgerSegments(sessionId, document, continueCapture);
  syncLedgerSessionAggregate(sessionId, document, continueCapture);
  return document;
}

/** Refresh the legacy session/index caches from per-segment placement state. */
export function syncLedgerSessionAggregate(
  sessionId: string,
  document: LedgerSegmentsDocument = ensureLedgerSegments(sessionId),
  continueCapture?: () => boolean,
): void {
  withTrailIdentityMutationLock(() => {
    requireCaptureContinuation(continueCapture);
    const session = readLedgerSession(sessionId);
    if (!session || document.segments.length === 0) return;
    const targets = new Map<string, LedgerTarget>();
    for (const segment of document.segments) {
      for (const target of segment.targets ?? []) targets.set(target.trailId, target);
    }
    const config = readGlobalConfig();
    for (const trailId of targets.keys()) assertTrailIdentityActive(trailId, config);
    assertLedgerIndexActive(readLedgerIndex());
    session.targets = [...targets.values()].map(cloneTarget);
    session.status = document.segments.every((segment) => segment.status === 'placed')
      ? 'placed'
      : 'inbox';
    const dismissed = document.segments
      .filter((segment) => segment.status === 'inbox')
      .map((segment) => segment.dismissedAt);
    if (dismissed.length > 0 && dismissed.every((value) => value !== undefined)) {
      session.dismissedAt = dismissed.sort().at(0);
    } else {
      delete session.dismissedAt;
    }
    writeLedgerSession(session, continueCapture);
    const now = new Date().toISOString();
    updateLedgerIndex((index) => {
      index.sessions[sessionId] = [...targets.keys()];
      for (const target of targets.values()) {
        index.trails[target.trailId] = { path: target.path, lastSeenAt: now };
      }
    }, continueCapture);
  });
}

/** Mark one turn placed; existing targets remain until cleanup commits. */
export function markLedgerSegmentPlaced(
  sessionId: string,
  segmentId: string,
  trailId: string,
  path: string,
  opts: { continueCapture?: () => boolean; pathRebase?: PathRebase } = {},
): void {
  withTrailIdentityMutationLock(() => {
    assertTrailIdentityActive(trailId);
    assertLedgerIndexActive(readLedgerIndex());
    updateLedgerSegment(
      sessionId,
      segmentId,
      (segment) => {
        const targets = segment.targets ?? [];
        const existing = targets.find((target) => target.trailId === trailId);
        if (existing) existing.path = path;
        else targets.push({ trailId, path });
        segment.targets = targets;
        segment.status = 'placed';
        delete segment.dismissedAt;
        if (opts.pathRebase) {
          const candidate = {
            fromRoot: resolve(opts.pathRebase.fromRoot),
            toRoot: resolve(opts.pathRebase.toRoot),
          };
          const rebases = segment.pathRebases ?? [];
          const previous = rebases.at(-1);
          if (
            pathKey(candidate.fromRoot) !== pathKey(candidate.toRoot) &&
            (!previous || !samePathRebase(previous, candidate))
          ) {
            rebases.push(candidate);
          }
          if (rebases.length > 0) segment.pathRebases = rebases;
        }
      },
      opts.continueCapture,
    );
  });
}

function ledgerRangeMemberIds(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
): string[] {
  if (typeof rangeOrSegment !== 'string') {
    return 'memberSegmentIds' in rangeOrSegment
      ? [...rangeOrSegment.memberSegmentIds]
      : [rangeOrSegment.id];
  }
  const range = listActionableLedgerRanges({
    includeHidden: true,
    sessionId,
  }).find(
    (candidate) =>
      candidate.selector === rangeOrSegment ||
      candidate.segment.id === rangeOrSegment ||
      candidate.memberSegmentIds.includes(rangeOrSegment),
  );
  return range?.memberSegmentIds ?? [rangeOrSegment];
}

/** Place every persisted member of one command-level range. */
export function placeLedgerRange(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
  trailId: string,
  path: string,
  opts: { continueCapture?: () => boolean; pathRebase?: PathRebase } = {},
): void {
  for (const segmentId of ledgerRangeMemberIds(sessionId, rangeOrSegment)) {
    markLedgerSegmentPlaced(sessionId, segmentId, trailId, path, opts);
  }
}

/** Return one segment to the inbox, optionally clearing stale placements. */
export function markLedgerSegmentInbox(
  sessionId: string,
  segmentId: string,
  opts: { continueCapture?: () => boolean; clearTargets?: boolean } = {},
): void {
  updateLedgerSegment(
    sessionId,
    segmentId,
    (segment) => {
      segment.status = 'inbox';
      if (opts.clearTargets) segment.targets = [];
    },
    opts.continueCapture,
  );
}

/** Dismiss one pending turn without hiding neighboring turns in the same chat. */
export function dismissLedgerSegment(sessionId: string, segmentId: string): void {
  updateLedgerSegment(sessionId, segmentId, (segment) => {
    if (segment.status === 'inbox' && !segment.dismissedAt) {
      segment.dismissedAt = new Date().toISOString();
    }
  });
}

/** Dismiss every segment represented by one collapsed pending range. */
export function dismissLedgerRange(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
): void {
  for (const segmentId of ledgerRangeMemberIds(sessionId, rangeOrSegment)) {
    dismissLedgerSegment(sessionId, segmentId);
  }
}

/** Undo one range dismissal. */
export function undismissLedgerSegment(sessionId: string, segmentId: string): void {
  updateLedgerSegment(sessionId, segmentId, (segment) => {
    delete segment.dismissedAt;
  });
}

export function undismissLedgerRange(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
): void {
  for (const segmentId of ledgerRangeMemberIds(sessionId, rangeOrSegment)) {
    undismissLedgerSegment(sessionId, segmentId);
  }
}

/** Return every member of a collapsed range to the inbox. */
export function markLedgerRangeInbox(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
  opts: { continueCapture?: () => boolean; clearTargets?: boolean } = {},
): void {
  for (const segmentId of ledgerRangeMemberIds(sessionId, rangeOrSegment)) {
    markLedgerSegmentInbox(sessionId, segmentId, opts);
  }
}

/** Remove one target from one turn after its projection cleanup commits. */
export function unlinkLedgerSegmentPlacement(
  sessionId: string,
  segmentId: string,
  trailId: string,
  opts: { continueCapture?: () => boolean } = {},
): void {
  updateLedgerSegment(
    sessionId,
    segmentId,
    (segment) => {
      segment.targets = (segment.targets ?? []).filter(
        (target) => target.trailId !== trailId,
      );
      if (segment.targets.length === 0) segment.status = 'inbox';
    },
    opts.continueCapture,
  );
}

export function unlinkLedgerRangePlacement(
  sessionId: string,
  rangeOrSegment: LedgerRangeView | LedgerSegment | string,
  trailId: string,
  opts: { continueCapture?: () => boolean } = {},
): void {
  for (const segmentId of ledgerRangeMemberIds(sessionId, rangeOrSegment)) {
    unlinkLedgerSegmentPlacement(sessionId, segmentId, trailId, opts);
  }
}

/** Persist a crash-resumable migration phase for one independently routed turn. */
export function setLedgerSegmentMigration(
  sessionId: string,
  segmentId: string,
  migration: LedgerSegmentMigration | undefined,
  continueCapture?: () => boolean,
): void {
  updateLedgerSegment(
    sessionId,
    segmentId,
    (segment) => {
      if (migration) segment.migration = cloneMigration(migration);
      else delete segment.migration;
    },
    continueCapture,
  );
}

/** Pending, deterministically routed turns claimable by one project root. */
export function pendingLedgerRangesForRoot(
  root: string,
  opts: { includeHidden?: boolean; persist?: boolean } = {},
): LedgerRangeView[] {
  const wanted = pathKey(resolve(root));
  return listActionableLedgerRanges({
    includeHidden: opts.includeHidden,
    pendingOnly: true,
    persist: opts.persist,
  }).filter(
    (view) =>
      (view.route.state === 'tracked' || view.route.state === 'candidate') &&
      pathKey(resolve(view.route.root)) === wanted,
  );
}

// --- placement ------------------------------------------------------------

/** Whether a `.showtail/` trail with the given id currently lives at `root`. */
export function trailExistsAt(root: string, trailId: string): boolean {
  return trailIdAt(root) === trailId;
}

/** The trailId currently stamped at a repo path, or undefined if no trail lives there. */
function trailIdAt(root: string): string | undefined {
  const config = join(root, '.showtail', 'config.json');
  if (!existsSync(config)) return undefined;
  try {
    const id = readJson<{ trailId?: string }>(config).trailId;
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a placed target still has a trail at its path — tolerating a `trailId`
 * that diverged under a merge (two clones that each auto-inited minted different
 * ids; the merge keeps one). A target is alive if SOME valid trail sits at the
 * path; when the path's current trailId differs from the recorded one, the
 * session + index are repointed to it, so the session isn't falsely flagged
 * target-missing after a merge. Returns false only when no trail exists there.
 */
function targetAlive(
  sessionId: string,
  target: LedgerTarget,
  repairTarget = true,
): boolean {
  const path = knownTrailPath(target.trailId) ?? target.path;
  const current = trailIdAt(path);
  if (!current) return false;
  if (repairTarget && current !== target.trailId) {
    repointTarget(sessionId, target.trailId, current, path);
  }
  return true;
}

/** Repoint a session's placement (and the index) from a stale trailId to the live one. */
function repointTarget(
  sessionId: string,
  oldTrailId: string,
  newTrailId: string,
  path: string,
): void {
  withTrailIdentityMutationLock(() => {
    assertTrailIdentityActive(newTrailId);
    const session = readLedgerSession(sessionId);
    if (session?.targets) {
      const t = session.targets.find((x) => x.trailId === oldTrailId);
      if (t) {
        t.trailId = newTrailId;
        t.path = path;
        writeLedgerSession(session);
      }
    }
    updateLedgerIndex((idx) => {
      const old = idx.trails[oldTrailId];
      delete idx.trails[oldTrailId];
      idx.trails[newTrailId] = {
        path,
        lastSeenAt: old?.lastSeenAt ?? new Date().toISOString(),
      };
      const list = idx.sessions[sessionId];
      if (list) {
        idx.sessions[sessionId] = list.map((trailId) =>
          trailId === oldTrailId ? newTrailId : trailId,
        );
      }
    });
  });
}

/**
 * Mark a session as placed into a trail and refresh the index. Records the
 * trail's current location (so a later move is recognized by id) and the
 * session→trail link (so `reattach` can find and undo a wrong placement).
 */
export function markPlaced(
  sessionId: string,
  trailId: string,
  path: string,
  opts: { continueCapture?: () => boolean; pathRebase?: PathRebase } = {},
): void {
  withTrailIdentityMutationLock(() => {
    assertTrailIdentityActive(trailId);
    assertLedgerIndexActive(readLedgerIndex());
    requireCaptureContinuation(opts.continueCapture);
    const session = readLedgerSession(sessionId);
    const originalSession = session
      ? {
          ...session,
          ...(session.targets
            ? { targets: session.targets.map((target) => ({ ...target })) }
            : {}),
          ...(session.pathRebases
            ? { pathRebases: session.pathRebases.map((rebase) => ({ ...rebase })) }
            : {}),
        }
      : null;
    let wroteSession = false;
    if (session) {
      const targets = session.targets ?? [];
      if (!targets.some((target) => target.trailId === trailId)) {
        targets.push({ trailId, path });
      } else {
        targets.find((target) => target.trailId === trailId)!.path = path;
      }
      session.targets = targets;
      session.status = 'placed';
      if (opts.pathRebase) {
        const candidate = {
          fromRoot: resolve(opts.pathRebase.fromRoot),
          toRoot: resolve(opts.pathRebase.toRoot),
        };
        const rebases = session.pathRebases ?? [];
        const previous = rebases.at(-1);
        const isNoOp = pathKey(candidate.fromRoot) === pathKey(candidate.toRoot);
        const repeatsTail =
          previous !== undefined &&
          pathKey(resolve(previous.fromRoot)) === pathKey(candidate.fromRoot) &&
          pathKey(resolve(previous.toRoot)) === pathKey(candidate.toRoot);
        if (!isNoOp && !repeatsTail) rebases.push(candidate);
        if (rebases.length > 0) session.pathRebases = rebases;
      }
      delete session.dismissedAt; // placement re-surfaces it; a stale dismissal shouldn't linger
      writeLedgerSession(session, opts.continueCapture);
      wroteSession = true;
    }
    const now = new Date().toISOString();
    try {
      updateLedgerIndex((idx) => {
        idx.trails[trailId] = { path, lastSeenAt: now };
        const list = idx.sessions[sessionId] ?? [];
        if (!list.includes(trailId)) list.push(trailId);
        idx.sessions[sessionId] = list;
      }, opts.continueCapture);
    } catch (error) {
      if (error instanceof CaptureInterruptedError && wroteSession && originalSession) {
        writeLedgerSession(originalSession, undefined, { preservePathRebases: false });
      }
      throw error;
    }

    // Compatibility wrapper: legacy callers still place a whole native session.
    // New command surfaces call markLedgerSegmentPlaced for one turn instead.
    try {
      const document = ensureLedgerSegments(sessionId);
      if (document.segments.length > 0) {
        for (const segment of document.segments) {
          const targets = segment.targets ?? [];
          const existing = targets.find((target) => target.trailId === trailId);
          if (existing) existing.path = path;
          else targets.push({ trailId, path });
          segment.targets = targets;
          segment.status = 'placed';
          delete segment.dismissedAt;
          if (opts.pathRebase) {
            const candidate = {
              fromRoot: resolve(opts.pathRebase.fromRoot),
              toRoot: resolve(opts.pathRebase.toRoot),
            };
            const rebases = segment.pathRebases ?? [];
            const previous = rebases.at(-1);
            if (
              pathKey(candidate.fromRoot) !== pathKey(candidate.toRoot) &&
              (!previous || !samePathRebase(previous, candidate))
            ) {
              rebases.push(candidate);
            }
            if (rebases.length > 0) segment.pathRebases = rebases;
          }
        }
        writeLedgerSegments(sessionId, document);
      }
    } catch {
      // The session/index remain the compatibility source if sidecar refresh fails.
    }
  });
}

/**
 * Whether two paths name the same directory on disk, even when spelled differently.
 *
 * A plain string compare is not enough: macOS resolves `/var` to `/private/var` (so
 * `process.cwd()` and a caller-supplied path disagree about the same folder), and
 * symlinks, junctions, and substituted drives do the same elsewhere. Falls back to
 * the string compare when either path can't be resolved — a missing directory is
 * exactly the case where they are legitimately different.
 */
function sameDirectory(a: string, b: string): boolean {
  if (pathKey(a) === pathKey(b)) return true;
  try {
    return pathKey(realpathSync(a)) === pathKey(realpathSync(b));
  } catch {
    return false;
  }
}

/** What {@link noteTrailLocation} observed about a trail's current whereabouts. */
export interface TrailLocationUpdate {
  /** True when the index was repointed because the trail is somewhere new. */
  moved: boolean;
  /** Where the index previously believed the trail lived. */
  previousPath?: string;
  /**
   * A live trail with the same id ALSO still sits at the previous path — so the
   * folder was COPIED, not moved, and two roots now claim one trailId. Callers
   * should warn: `targetAlive` finds the old path alive and never repoints, so
   * placements silently keep favouring the original.
   */
  duplicated: boolean;
}

/**
 * Record that trail `trailId` is currently at `path`, closing the "target missing"
 * window without waiting for the next AI session.
 *
 * Why this is needed: {@link markPlaced} is otherwise the ONLY writer of the
 * trailId→path index, and it runs only from a live hook or an explicit
 * `move`/`reattach`. So a student who moved their project and then simply ran
 * `showtail report` kept seeing every past session flagged target-missing, with
 * nothing to repair it. Any command that resolves a real trail can call this.
 * Because the index is keyed by trailId — which travels inside the folder, in
 * `.showtail/config.json` — one call repoints every historical session on that
 * trail at once.
 *
 * Safe by construction: it writes only after confirming a trail with that exact id
 * really is at `path`, so it can never point the index at an unrelated folder.
 */
export function noteTrailLocation(trailId: string, path: string): TrailLocationUpdate {
  return withTrailIdentityMutationLock(() => {
    assertTrailIdentityActive(trailId);
    const resolved = resolve(path);
    const known = knownTrailPath(trailId);
    if (known !== undefined && sameDirectory(known, resolved)) {
      // Same place, possibly spelled differently — not a move. This matters: on macOS
      // `process.cwd()` reports a directory's realpath (`/private/var/…`) when the
      // caller passed `/var/…`, and symlinked or substituted paths do the same.
      // Treating that as a relocation would rewrite a perfectly correct recorded path
      // into a different spelling and break every equality check against it.
      return { moved: false, previousPath: known, duplicated: false };
    }
    if (trailIdAt(resolved) !== trailId) {
      return { moved: false, previousPath: known, duplicated: false };
    }
    // A live trail with this id at the OLD path too means the folder was copied rather
    // than moved — only meaningful now that we know the two paths are different places.
    const duplicated = known !== undefined && trailIdAt(known) === trailId;
    updateLedgerIndex((idx) => {
      idx.trails[trailId] = { path: resolved, lastSeenAt: new Date().toISOString() };
    });
    return { moved: true, previousPath: known, duplicated };
  });
}

/**
 * Convenience for commands: repoint the index for whatever trail lives at `root`.
 * Returns null when there is no trail there (or it predates trail ids). Best-effort
 * bookkeeping — callers may ignore the result entirely.
 */
export function noteTrailAt(root: string): TrailLocationUpdate | null {
  const trailId = trailIdAt(root);
  if (!trailId) return null;
  try {
    return noteTrailLocation(trailId, root);
  } catch {
    return null; // index bookkeeping must never break a read-only command
  }
}

/** Mark a session as awaiting placement (root-less scratch / no eligible anchor). */
export function markInbox(
  sessionId: string,
  opts: { continueCapture?: () => boolean } = {},
): void {
  requireCaptureContinuation(opts.continueCapture);
  const session = readLedgerSession(sessionId);
  if (!session || session.status === 'placed') return;
  session.status = 'inbox';
  writeLedgerSession(session, opts.continueCapture);
  try {
    const document = ensureLedgerSegments(sessionId);
    for (const segment of document.segments) segment.status = 'inbox';
    writeLedgerSegments(sessionId, document);
  } catch {
    // Compatibility metadata was already persisted above.
  }
}

/**
 * Dismiss an inbox session from the default view (reversible; stays in the ledger
 * and under `--all`/`move`). No-op on a placed session. Idempotent — keeps the
 * first dismissal time.
 */
export function dismissLedgerSession(id: string): void {
  const session = readLedgerSession(id);
  if (!session || session.status === 'placed' || session.dismissedAt) return;
  session.dismissedAt = new Date().toISOString();
  writeLedgerSession(session);
  try {
    const document = ensureLedgerSegments(session);
    for (const segment of document.segments) {
      if (segment.status === 'inbox' && !segment.dismissedAt) {
        segment.dismissedAt = session.dismissedAt;
      }
    }
    writeLedgerSegments(id, document);
  } catch {
    // Compatibility metadata was already persisted above.
  }
}

/** Undo a dismissal, so the session can surface again if it otherwise qualifies. */
export function undismissLedgerSession(id: string): void {
  const session = readLedgerSession(id);
  if (!session || !session.dismissedAt) return;
  delete session.dismissedAt;
  writeLedgerSession(session);
  try {
    const document = ensureLedgerSegments(session);
    for (const segment of document.segments) delete segment.dismissedAt;
    writeLedgerSegments(id, document);
  } catch {
    // Compatibility metadata was already persisted above.
  }
}

/** Forget a session's placement into one trail (used when `reattach` moves it). */
export function unlinkPlacement(sessionId: string, trailId: string): void {
  const session = readLedgerSession(sessionId);
  if (session?.targets) {
    session.targets = session.targets.filter((t) => t.trailId !== trailId);
    if (session.targets.length === 0) session.status = 'inbox';
    writeLedgerSession(session);
  }
  updateLedgerIndex((idx) => {
    if (idx.sessions[sessionId]) {
      idx.sessions[sessionId] = idx.sessions[sessionId].filter((t) => t !== trailId);
    }
  });
  try {
    const document = ensureLedgerSegments(sessionId);
    for (const segment of document.segments) {
      segment.targets = (segment.targets ?? []).filter(
        (target) => target.trailId !== trailId,
      );
      if (segment.targets.length === 0) segment.status = 'inbox';
    }
    writeLedgerSegments(sessionId, document);
  } catch {
    // Compatibility metadata was already persisted above.
  }
}

/** Resolve a ledger session by a full or unambiguous prefix id (for the CLI). */
export function resolveLedgerSessionId(prefix: string): LedgerSession | null {
  const exact = readLedgerSession(prefix);
  if (exact) return exact;
  const matches = allLedgerSessions().filter((s) => s.id.startsWith(prefix));
  return matches.length === 1 ? matches[0]! : null;
}

/** The last-known path of a trail, from the index (for reattach/move reporting). */
export function knownTrailPath(trailId: string): string | undefined {
  return readLedgerIndex().trails[trailId]?.path;
}

/**
 * Retire a transient same-path trail id after all ranges have left it. The live
 * canonical config, ledger placements, and old index location are validated
 * before either discovery catalog is changed.
 */
export function supersedeTrailIdentity(
  supersededTrailId: string,
  canonicalTrailId: string,
  canonicalPath: string,
): void {
  withTrailIdentityMutationLock(() => {
    const root = resolve(canonicalPath);
    if (!supersededTrailId || supersededTrailId === canonicalTrailId) {
      throw new Error('A trail supersession requires two distinct trail ids.');
    }
    assertTrailIdentityActive(canonicalTrailId);
    if (!trailExistsAt(root, canonicalTrailId)) {
      throw new Error(`Canonical trail ${canonicalTrailId} is not live at ${root}.`);
    }
    const existing = trailIdentitySupersession(supersededTrailId);
    if (
      existing &&
      (existing.canonicalTrailId !== canonicalTrailId ||
        !sameDirectory(existing.canonicalPath, root))
    ) {
      throw new Error(`Trail ${supersededTrailId} is already superseded elsewhere.`);
    }
    const index = readLedgerIndex();
    const oldPath = index.trails[supersededTrailId]?.path;
    if (!existing && (!oldPath || !sameDirectory(oldPath, root))) {
      throw new Error(
        `Trail ${supersededTrailId} is not indexed at canonical path ${root}.`,
      );
    }
    for (const session of allLedgerSessions()) {
      if (
        (session.targets ?? []).some((target) => target.trailId === supersededTrailId)
      ) {
        throw new Error(
          `Trail ${supersededTrailId} still owns ledger session ${session.id}.`,
        );
      }
      const document = ensureLedgerSegments(session, { persist: false });
      if (
        document.segments.some((segment) =>
          (segment.targets ?? []).some((target) => target.trailId === supersededTrailId),
        )
      ) {
        throw new Error(
          `Trail ${supersededTrailId} still owns a range in ${session.id}.`,
        );
      }
    }
    recordTrailIdentitySupersession(supersededTrailId, canonicalTrailId, root);
    updateLedgerIndex((current) => {
      delete current.trails[supersededTrailId];
      current.trails[canonicalTrailId] = {
        path: root,
        lastSeenAt:
          current.trails[canonicalTrailId]?.lastSeenAt ?? new Date().toISOString(),
      };
      for (const [sessionId, trailIds] of Object.entries(current.sessions)) {
        current.sessions[sessionId] = trailIds.filter(
          (trailId) => trailId !== supersededTrailId,
        );
      }
    });
  });
}
