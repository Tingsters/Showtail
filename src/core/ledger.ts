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
 * `records.jsonl` is append-only (atomic per-line writes); `session.json` and
 * `index.json` use the atomic temp+rename + re-read-before-write tolerance the
 * rest of the codebase uses. No lock is needed — materialize is idempotent.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ConversationEvent, Tool } from '../types.ts';
import { ledgerDir, readInboxMinSignal, readScratchPaths } from './globalConfig.ts';
import { makeId } from './ids.ts';
import {
  appendJsonl,
  eligibleProjectRoot,
  isPathUnder,
  pathKey,
  readJson,
  readJsonl,
  writeJson,
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
  /** Working directory at capture time — the cwd-fallback target when no edit-path root resolves. */
  cwd?: string;
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

/** Read-modify-write the index atomically (tolerant of a concurrent writer). */
function updateLedgerIndex(mutate: (idx: LedgerIndex) => void): LedgerIndex {
  const idx = readLedgerIndex();
  mutate(idx);
  writeJson(indexFile(), idx);
  return idx;
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

/** Persist one ledger session's metadata (atomic temp+rename). */
export function writeLedgerSession(session: LedgerSession): void {
  writeJson(sessionFile(session.id), session);
}

/** Fields needed to find or open a ledger session. */
export interface EnsureLedgerSessionInput {
  tool: Tool;
  /** The tool's own session id — required: it's how the ledger correlates hook events. */
  nativeSessionId: string;
  /** The capturing machine's id when known (informational; not part of the key). */
  machineId?: string;
  slug?: string;
  cwd?: string;
}

/**
 * Find the open ledger session for a tool session, creating it on first sight.
 * Mirrors {@link sessionForNativeSession}: binds to the *open* session for the
 * keying triple; a session already ended (idle/SessionEnd) is left in place and a
 * continuation gets a fresh one. Re-reads the index right before writing to
 * shrink the window a concurrent first-hook could clobber the push.
 */
export function ensureLedgerSession(input: EnsureLedgerSessionInput): LedgerSession {
  const key = sessionKey(input.tool, input.nativeSessionId);
  const now = new Date().toISOString();

  const idx = readLedgerIndex();
  const existingId = idx.byKey[key];
  if (existingId) {
    const existing = readLedgerSession(existingId);
    if (existing && !existing.endedAt) {
      // Refresh the cheap, mutable hints; keep the rest as-is.
      existing.lastSeenAt = now;
      if (input.cwd && !existing.cwd) existing.cwd = input.cwd;
      if (input.slug && !existing.slug) existing.slug = input.slug;
      writeLedgerSession(existing);
      return existing;
    }
  }

  const session: LedgerSession = {
    id: makeId('led'),
    tool: input.tool,
    nativeSessionId: input.nativeSessionId,
    machineId: input.machineId,
    slug: input.slug,
    cwd: input.cwd,
    startedAt: now,
    lastSeenAt: now,
    status: 'inbox',
  };
  mkdirSync(sessionDir(session.id), { recursive: true });
  writeLedgerSession(session);
  // Claim the key under a fresh read: if a concurrent hook just opened a session
  // for the same triple, adopt theirs and leave ours an unindexed orphan dir
  // (harmless — never listed). Otherwise take the slot.
  let winnerId = session.id;
  updateLedgerIndex((i) => {
    const open = i.byKey[key];
    const openSession = open ? readLedgerSession(open) : null;
    if (openSession && !openSession.endedAt) {
      winnerId = open!;
    } else {
      i.byKey[key] = session.id;
      winnerId = session.id;
    }
  });
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

/** Record the prompt record id that opens the current turn (for replay linkage). */
export function setLedgerTurn(id: string, turnKey: string): void {
  const session = readLedgerSession(id);
  if (!session) return;
  session.currentTurnKey = turnKey;
  writeLedgerSession(session);
}

/**
 * Remember where this session's host transcript lives, so the catch-up sweep can
 * re-read it later (see {@link LedgerSession.transcriptPath}). No-op when the
 * path is already recorded, so the common case costs nothing.
 */
export function setLedgerTranscriptPath(id: string, transcriptPath: string): void {
  const session = readLedgerSession(id);
  if (!session || session.transcriptPath === transcriptPath) return;
  session.transcriptPath = transcriptPath;
  writeLedgerSession(session);
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

/** Prompt/edit counts, first prompt text, and absolute edit paths — one records read. */
function sessionFacts(id: string): {
  prompts: number;
  edits: number;
  firstPrompt?: string;
  editPaths: string[];
} {
  let prompts = 0;
  let edits = 0;
  let firstPrompt: string | undefined;
  const editPaths: string[] = [];
  for (const rec of readLedgerRecords(id)) {
    if (rec.kind === 'edit') {
      edits += 1;
      if (rec.file) editPaths.push(rec.file);
    } else if (rec.kind === 'prompt') {
      prompts += 1;
      if (!firstPrompt && rec.text) firstPrompt = rec.text;
    }
  }
  return { prompts, edits, firstPrompt, editPaths };
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

/** Distinct eligible project roots for a set of edit paths (cwd fallback when edit-less). */
function workRootsFrom(editPaths: string[], cwd?: string): string[] {
  const dirs = editPaths.length ? editPaths.map((p) => dirname(p)) : cwd ? [cwd] : [];
  const roots = new Set<string>();
  for (const d of dirs) {
    const root = eligibleProjectRoot(d);
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * The eligible project roots a session's work resolves to (via `.showtail/`/git,
 * excluding home + temp). Non-empty ⇒ the work lives in a real project. Used by the
 * surface predicate and to group the inbox listing.
 */
export function sessionWorkRoots(session: LedgerSession): string[] {
  return workRootsFrom(sessionFacts(session.id).editPaths, session.cwd);
}

/**
 * Whether any of the session's edit paths (or its `cwd`, when edit-less) is under
 * `folder` — a raw prefix membership test (NOT resolved-root), so targeting a
 * subfolder of a session's git/`.showtail` root still matches. Powers the scratch
 * list and `track`'s backfill.
 */
export function sessionTouchesPath(session: LedgerSession, folder: string): boolean {
  const targets = recordedPaths(sessionFacts(session.id), session.cwd);
  return targets.some((p) => isPathUnder(p, folder));
}

/**
 * The recorded locations of a session's work: its edited files, or its `cwd` when
 * it made no edits. These are absolute and machine-local (see the module note), so
 * they are exactly what goes stale when the student moves their files.
 */
function recordedPaths(facts: { editPaths: string[] }, cwd?: string): string[] {
  return facts.editPaths.length ? facts.editPaths : cwd ? [cwd] : [];
}

/**
 * Whether every path this session recorded has vanished from disk — the signature
 * of moved (or deleted) work, as opposed to work that simply never sat in a
 * project. Worth distinguishing because the two need opposite treatment: a folder
 * that isn't a project is genuinely scratch, while work whose files moved is real
 * work that must stay visible so it can be recovered (see {@link hiddenReason}).
 */
export function sessionPathsGone(session: LedgerSession): boolean {
  const { editPaths } = sessionFacts(session.id);
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
  return session.cwd !== undefined && !existsSync(session.cwd);
}

/** Why a session is hidden from the default inbox, or null when it surfaces. */
export type HiddenReason = 'dismissed' | 'not-in-project' | 'low-signal' | 'ignored-path';

/**
 * The reason a never-placed session is hidden (see {@link isSurfaced}), or null.
 *
 * Note the deliberate asymmetry fix: when a session's recorded paths have all
 * vanished, `workRootsFrom` cannot resolve a root and would report
 * `'not-in-project'` — hiding moved work in the one view the student is told to
 * check. Gone paths therefore skip that verdict and fall through to the ordinary
 * signal/scratch filters, mirroring the guarantee `unplacedSessions` already gives
 * target-missing sessions. Trivial gone-path sessions still stay hidden as
 * `'low-signal'`, so the default inbox doesn't fill up with noise.
 */
export function hiddenReason(session: LedgerSession): HiddenReason | null {
  if (session.dismissedAt) return 'dismissed';
  const facts = sessionFacts(session.id);
  if (
    workRootsFrom(facts.editPaths, session.cwd).length === 0 &&
    !sessionPathsGone(session)
  )
    return 'not-in-project';
  const min = readInboxMinSignal();
  if (!(facts.edits >= min.edits || facts.prompts >= min.prompts)) return 'low-signal';
  const targets = recordedPaths(facts, session.cwd);
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
 * By default only *surfaced* inbox sessions are returned (real-project, signal-
 * bearing, not scratch/dismissed); `includeHidden` returns every inbox session so
 * `showtail inbox --all` can reveal the rest. `target-missing` sessions always
 * surface — they are placed real work whose repo vanished.
 */
export function unplacedSessions(
  opts: { includeHidden?: boolean } = {},
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
    // alive-check repoints a trailId that diverged under a merge (CC2), so a valid
    // trail at the path is never mistaken for a missing one.
    const targets = session.targets ?? [];
    if (targets.length === 0) continue;
    const anyAlive = targets.some((t) => targetAlive(session.id, t));
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
 * folder), inbox, or target-missing. Powers `showtail move`'s full listing. The
 * alive-check self-heals a trailId that diverged under a merge (CC2).
 */
export function allLedgerSessionViews(): LedgerSessionView[] {
  return allLedgerSessions().map((session) => {
    const targets = session.targets ?? [];
    const targetPaths = targets.map((t) => knownTrailPath(t.trailId) ?? t.path);
    let targetMissing = false;
    if (session.status === 'placed' && targets.length > 0) {
      targetMissing = !targets.some((t) => targetAlive(session.id, t));
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
function targetAlive(sessionId: string, target: LedgerTarget): boolean {
  const path = knownTrailPath(target.trailId) ?? target.path;
  const current = trailIdAt(path);
  if (!current) return false;
  if (current !== target.trailId) repointTarget(sessionId, target.trailId, current, path);
  return true;
}

/** Repoint a session's placement (and the index) from a stale trailId to the live one. */
function repointTarget(
  sessionId: string,
  oldTrailId: string,
  newTrailId: string,
  path: string,
): void {
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
    if (list)
      idx.sessions[sessionId] = list.map((t) => (t === oldTrailId ? newTrailId : t));
  });
}

/**
 * Mark a session as placed into a trail and refresh the index. Records the
 * trail's current location (so a later move is recognized by id) and the
 * session→trail link (so `reattach` can find and undo a wrong placement).
 */
export function markPlaced(sessionId: string, trailId: string, path: string): void {
  const session = readLedgerSession(sessionId);
  if (session) {
    const targets = session.targets ?? [];
    if (!targets.some((t) => t.trailId === trailId)) targets.push({ trailId, path });
    else targets.find((t) => t.trailId === trailId)!.path = path;
    session.targets = targets;
    session.status = 'placed';
    delete session.dismissedAt; // placement re-surfaces it; a stale dismissal shouldn't linger
    writeLedgerSession(session);
  }
  const now = new Date().toISOString();
  updateLedgerIndex((idx) => {
    idx.trails[trailId] = { path, lastSeenAt: now };
    const list = idx.sessions[sessionId] ?? [];
    if (!list.includes(trailId)) list.push(trailId);
    idx.sessions[sessionId] = list;
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
export function markInbox(sessionId: string): void {
  const session = readLedgerSession(sessionId);
  if (!session || session.status === 'placed') return;
  session.status = 'inbox';
  writeLedgerSession(session);
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
}

/** Undo a dismissal, so the session can surface again if it otherwise qualifies. */
export function undismissLedgerSession(id: string): void {
  const session = readLedgerSession(id);
  if (!session || !session.dismissedAt) return;
  delete session.dismissedAt;
  writeLedgerSession(session);
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
