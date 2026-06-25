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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../types.ts';
import { ledgerDir } from './globalConfig.ts';
import { makeId } from './ids.ts';
import { appendJsonl, readJson, readJsonl, writeJson } from './storage.ts';

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
}

/** The kind of a single captured record. */
export type LedgerRecordKind = 'prompt' | 'ai_output' | 'decision' | 'plan' | 'edit';

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

/**
 * Sessions awaiting placement: explicitly `inbox`, or `placed` into a trail that
 * has since gone missing (a deleted repo, or a moved one not yet re-seen). The
 * `targetMissing` flag tells the two apart for the `inbox` listing.
 */
export function unplacedSessions(): Array<LedgerSession & { targetMissing?: boolean }> {
  const out: Array<LedgerSession & { targetMissing?: boolean }> = [];
  for (const session of allLedgerSessions()) {
    if (session.status === 'inbox') {
      out.push(session);
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
    id: makeId(input.kind === 'edit' ? 'art' : 'evt'),
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

/** Mark a session as awaiting placement (root-less scratch / no eligible anchor). */
export function markInbox(sessionId: string): void {
  const session = readLedgerSession(sessionId);
  if (!session || session.status === 'placed') return;
  session.status = 'inbox';
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
