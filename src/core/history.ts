/** Central, transactional history. Projects are indexes, never storage destinations. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { dataHome, dataPath, ensureDataHome, physicalPath } from './dataHome.ts';
import { readGlobalConfig } from './globalConfig.ts';
import { readMachineIdentity, syntheticIdentity } from './identity.ts';
import { redact } from './redact.ts';
import { withholdSensitiveParts, ALWAYS_CAPTURE_TOOLS } from './conversationPrivacy.ts';
import { isSensitivePath } from './sensitivePaths.ts';
import { isSyntheticPrompt } from './syntheticPrompt.ts';
import type { ConversationEvent, RedactConfig } from '../types.ts';

export const HISTORY_VERSION = 2;
export const CONTROL_VERSION = 2;
export type RecordKind =
  | 'prompt'
  | 'ai_output'
  | 'edit'
  | 'decision'
  | 'plan'
  | 'tool_call'
  | 'recap'
  | 'conversation_event'
  | 'audit';
export interface HistorySettings {
  captureAiOutput?: boolean;
  captureCode?: boolean;
  captureToolCalls?: boolean;
  captureToolOutput?: boolean;
  redact?: RedactConfig;
}
export function historySettings(): HistorySettings {
  return (readGlobalConfig() as { settings?: HistorySettings }).settings ?? {};
}
export interface HistorySession {
  id: string;
  tool: string;
  nativeSessionId: string;
  parentNativeSessionId?: string;
  authorId: string;
  cwd: string | null;
  workspacePaths: string[];
  startedAt: string;
  lastSeenAt: string;
  endedAt?: string;
  currentTurnId?: string;
  transcriptPath?: string;
  automaticSince?: string;
}
export interface SessionInput {
  endedAt?: string;
  tool: string;
  nativeSessionId?: string;
  cwd?: string | null;
  workspacePaths?: string[];
  startedAt?: string;
  authorId?: string;
  authorName?: string;
  transcriptPath?: string;
  automaticSince?: string;
}
export interface RecordInput {
  origin?: 'human' | 'agent' | 'harness';
  duplicateOf?: string;
  id?: string;
  kind: RecordKind;
  ts?: string;
  sourceId?: string;
  turnId?: string;
  text?: string;
  diff?: string;
  file?: string;
  unresolvedPath?: boolean;
  sha256?: string;
  deleted?: boolean;
  approved?: boolean;
  model?: string;
  tags?: string[];
  toolName?: string;
  isError?: boolean;
  gitCommit?: string;
  gitBranch?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  conversationEvent?: ConversationEvent;
  context?: { cwd?: string | null; workspacePaths?: string[] };
  provenance?: {
    source: string;
    id: string;
    batch?: string;
    legacyIntegrity?: 'unverified';
  };
  /** A correlation key supplied by the provider, never a prompt-text fingerprint. */
  requestId?: string;
  transcriptFinal?: boolean;
}
export interface HistoryRecord extends RecordInput {
  id: string;
  sessionId: string;
  sequence: number;
  ts: string;
  capturedAt: string;
  turnId?: string;
  prev: string | null;
  hash: string;
  supersedesId?: string;
  redacted: number;
}
export interface ProjectView {
  projectId: string;
  displayName: string;
  roots: string[];
  projectRoot: string | null;
}
export type HistorySelection =
  | { kind: 'all'; tool?: string; since?: string; until?: string }
  | { kind: 'project'; projectId: string; tool?: string; since?: string; until?: string }
  | {
      kind: 'sessions';
      sessionIds: string[];
      tool?: string;
      since?: string;
      until?: string;
    };

type Row = Record<string, any>;
const MARKERS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'Makefile',
  'requirements.txt',
  'CMakeLists.txt',
];
export const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export function pathIdentity(path: string): string {
  const value = physicalPath(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
export function containsPath(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return (
    rel === '' ||
    (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
      rel !== '..' &&
      !isAbsolute(rel))
  );
}

/** Provider text and legacy command fragments are never workspace identities. */
export function isUsableWorkspacePath(path: string): boolean {
  if (!isAbsolute(path) || path.length > 32767 || /[\x00-\x1f\x7f]/.test(path))
    return false;
  const checked = process.platform === 'win32' ? path.replace(/^\\\\\?\\/, '') : path;
  if (process.platform === 'win32' && /[<>:"|?*]/.test(checked.replace(/^[A-Za-z]:/, '')))
    return false;
  return checked.split(/[\\/]/).every((part) => part.length <= 255);
}

/** Read project evidence only. A .showtail directory is deliberately not evidence. */
export function workspaceRoot(path: string, workspaces: string[] = []): string {
  if (!isUsableWorkspacePath(path))
    throw new Error(
      'INVALID_PROJECT_PATH: workspace paths must be absolute file-system paths.',
    );
  let dir = resolve(path);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    /* A caller passes dirname for deleted files. */
  }
  const start = dir;
  let marker: string | undefined;
  while (true) {
    if (pathIdentity(dir) === pathIdentity(homedir()) && dir !== start) break;
    if (existsSync(join(dir, '.git'))) return dir;
    if (!marker && MARKERS.some((name) => existsSync(join(dir, name)))) marker = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const declared = workspaces
    .filter((root) => containsPath(root, start))
    .sort((a, b) => b.length - a.length)[0];
  return marker ?? declared ?? start;
}

/** The Git common directory identifies a repository across its worktrees. */
export function repositoryIdentity(path: string): string | undefined {
  if (/^\\\\[^?]/.test(path) || !existsSync(path)) return;
  let root: string;
  try {
    root = workspaceRoot(path);
  } catch {
    return;
  }
  let git = join(root, '.git');
  if (!existsSync(git)) return;
  try {
    const pointer = readFileSync(git, 'utf8').match(/^gitdir:\s*(.+)/m)?.[1];
    if (pointer) git = resolve(root, pointer.trim());
  } catch {
    /* directory */
  }
  try {
    git = resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim());
  } catch {
    /* main checkout */
  }
  return pathIdentity(git);
}

export function canonical(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((key) => v[key] !== undefined)
              .map((key) => [key, sort(v[key])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** No fallback to an empty database on corruption or an unknown schema version. */
export class HistoryStore {
  readonly home: string;
  readonly db: Database;
  readonly readonly: boolean;
  repairSchema = false;
  private overlayCache?: Map<string, Partial<HistoryRecord>>;
  private authorCache?: Map<string, string>;
  private projectCache?: ProjectView[];
  constructor(options: { readonly?: boolean } = {}) {
    this.home = options.readonly ? dataHome() : ensureDataHome();
    this.readonly = options.readonly === true;
    this.db = new Database(dataPath('history.sqlite'), {
      readonly: this.readonly,
      create: !this.readonly,
      strict: true,
    });
    try {
      this.db.exec(
        'PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;',
      );
      const version = (this.query('PRAGMA user_version').get() as Row).user_version;
      if (version > HISTORY_VERSION)
        throw new Error(
          `HISTORY_NEWER_THAN_BINARY: store version ${version}; update Showtail before opening it.`,
        );
      if (!this.readonly) {
        chmodSync(dataPath('history.sqlite'), 0o600);
        const sqlite = String(
          (this.query('SELECT sqlite_version() AS version').get() as Row).version,
        );
        const [major, minor, patch] = sqlite.split('.').map(Number) as [
          number,
          number,
          number,
        ];
        const fixed =
          major > 3 ||
          (major === 3 &&
            (minor > 51 ||
              (minor === 51 && patch >= 3) ||
              (minor === 50 && patch >= 7) ||
              (minor === 44 && patch >= 6)));
        this.db.exec(
          `PRAGMA journal_mode = ${fixed ? 'WAL' : 'DELETE'}; PRAGMA synchronous = FULL;`,
        );
        if (version === 0) this.initialize();
        this.transaction(() =>
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS repair_receipts(id TEXT PRIMARY KEY, ts TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS record_overlays(record_id TEXT PRIMARY KEY REFERENCES records(id), patch TEXT NOT NULL, repair_id TEXT NOT NULL REFERENCES repair_receipts(id));
          CREATE TABLE IF NOT EXISTS ancestor_aliases(session_id TEXT NOT NULL REFERENCES sessions(id), source_id TEXT NOT NULL, record_id TEXT NOT NULL REFERENCES records(id), repair_id TEXT NOT NULL REFERENCES repair_receipts(id), PRIMARY KEY(session_id, source_id));
          CREATE TABLE IF NOT EXISTS author_overrides(source TEXT PRIMARY KEY REFERENCES authors(id), target TEXT NOT NULL REFERENCES authors(id), repair_id TEXT NOT NULL REFERENCES repair_receipts(id));
          CREATE TABLE IF NOT EXISTS source_reads(session_id TEXT PRIMARY KEY REFERENCES sessions(id), payload TEXT NOT NULL);
          PRAGMA user_version = 2;
        `),
        ).immediate();
        // Existing v1 stores also need this index: current-record reads correlate
        // supersession lookups once per row, including large imported histories.
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS records_supersedes ON records(supersedes_id) WHERE supersedes_id IS NOT NULL',
        );
      } else if (version < 1) throw new Error('HISTORY_NOT_INITIALIZED');
      this.repairSchema = !this.readonly || version >= 2;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close(true);
  }
  [Symbol.dispose](): void {
    this.close();
  }

  /** Finalize each statement promptly; never hold a reader open across hooks. */
  query(sql: string) {
    const call = (method: 'get' | 'all' | 'run', args: any[]) => {
      const statement = this.db.prepare(sql);
      try {
        return (statement[method] as (...values: any[]) => any).apply(statement, args);
      } finally {
        statement.finalize();
      }
    };
    return {
      get: (...args: any[]): any => call('get', args),
      all: (...args: any[]): any[] => call('all', args),
      run: (...args: any[]): any => call('run', args),
    };
  }

  /** Explicit SQL boundaries avoid retaining Bun's cached transaction statements. */
  transaction<T>(fn: () => T): { immediate: () => T } {
    return {
      immediate: () => {
        const nested = this.db.inTransaction;
        const savepoint = `showtail_${randomUUID().replace(/-/g, '')}`;
        this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
        try {
          const value = fn();
          if (value instanceof Promise)
            throw new Error('History transactions must be synchronous.');
          this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
          return value;
        } catch (error) {
          this.overlayCache = undefined;
          this.authorCache = undefined;
          this.projectCache = undefined;
          if (this.db.inTransaction)
            this.db.exec(
              nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK',
            );
          throw error;
        }
      },
    };
  }

  private initialize(): void {
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, native_id TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES authors(id),
        cwd TEXT, workspaces TEXT NOT NULL, started_at TEXT NOT NULL, last_seen TEXT NOT NULL,
        ended_at TEXT, current_turn TEXT, transcript_path TEXT, automatic_since TEXT, UNIQUE(tool, native_id)
      );
      CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
        ts TEXT NOT NULL, captured_at TEXT NOT NULL, kind TEXT NOT NULL, turn_id TEXT,
        source_id TEXT, payload TEXT NOT NULL, prev TEXT, hash TEXT NOT NULL,
        supersedes_id TEXT REFERENCES records(id), redacted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS records_turn ON records(turn_id);
      CREATE INDEX IF NOT EXISTS records_time ON records(ts);
      CREATE TABLE IF NOT EXISTS source_aliases (
        session_id TEXT NOT NULL REFERENCES sessions(id), source_id TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(session_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_roots (project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, key TEXT NOT NULL UNIQUE, current INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS turn_projects (turn_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), origin TEXT NOT NULL, PRIMARY KEY(turn_id, project_id, origin));
      CREATE TABLE IF NOT EXISTS manual_turns (turn_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS imports (source TEXT NOT NULL, source_id TEXT NOT NULL, record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(source, source_id));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `),
    ).immediate();
  }

  /** Corrections affect the view; original capture rows remain hash-verifiable. */
  effectiveAuthor(id: string): string {
    if (!this.repairSchema) return id;
    this.authorCache ??= new Map(
      (this.query('SELECT source,target FROM author_overrides').all() as Row[]).map(
        (r) => [r.source, r.target],
      ),
    );
    const seen = new Set<string>();
    while (this.authorCache.has(id) && !seen.has(id)) {
      seen.add(id);
      id = this.authorCache.get(id)!;
    }
    return id;
  }
  currentAuthor(): { id: string; name: string } {
    return this.localAuthor();
  }
  private overlays(): Map<string, Partial<HistoryRecord>> {
    return (this.overlayCache ??= new Map(
      this.repairSchema
        ? (this.query('SELECT record_id,patch FROM record_overlays').all() as Row[]).map(
            (r) => [r.record_id, JSON.parse(r.patch)],
          )
        : [],
    ));
  }
  overlayRecord(id: string, patch: Partial<HistoryRecord>, repairId: string): void {
    const allowed = new Set([
      'kind',
      'turnId',
      'model',
      'sourceId',
      'origin',
      'duplicateOf',
      'context',
    ]);
    if (Object.keys(patch).some((k) => !allowed.has(k)))
      throw new Error('INVALID_REPAIR_OVERLAY');
    const merged = { ...this.overlays().get(id), ...patch };
    this.query(
      'INSERT INTO record_overlays VALUES (?,?,?) ON CONFLICT(record_id) DO UPDATE SET patch=excluded.patch,repair_id=excluded.repair_id',
    ).run(id, canonical(merged), repairId);
    this.overlayCache = undefined;
  }
  mapAuthor(source: string, target: string, repairId: string): void {
    if (source === target || this.effectiveAuthor(target) === source)
      throw new Error('AUTHOR_MAPPING_CYCLE');
    this.query(
      'INSERT INTO author_overrides VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET target=excluded.target,repair_id=excluded.repair_id',
    ).run(source, target, repairId);
    this.authorCache = undefined;
  }
  sourceReads(): { sessionId: string; [key: string]: any }[] {
    return this.repairSchema
      ? (this.query('SELECT session_id,payload FROM source_reads').all() as Row[]).map(
          (r) => ({ sessionId: r.session_id, ...JSON.parse(r.payload) }),
        )
      : [];
  }
  noteSourceRead(sessionId: string, payload: Record<string, unknown>): void {
    this.query(
      'INSERT INTO source_reads VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload',
    ).run(sessionId, canonical(payload));
  }

  private localAuthor(): { id: string; name: string } {
    const identity = readMachineIdentity() ?? syntheticIdentity();
    const email = process.env.SHOWTAIL_IDENTITY_EMAIL ?? identity.email;
    return {
      id: 'author_' + digest(email).slice(0, 24),
      name: process.env.SHOWTAIL_IDENTITY_NAME ?? identity.name,
    };
  }

  ensureSession(input: SessionInput): HistorySession {
    const nativeId = input.nativeSessionId || `synthetic:${randomUUID()}`;
    const id = 'ses_' + digest(`${input.tool}\0${nativeId}`).slice(0, 24);
    const author = this.localAuthor();
    const authorId = input.authorId ?? author.id;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.query(
        'INSERT INTO authors(id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
      ).run(authorId, input.authorName ?? author.name);
      const existing = this.session(id);
      const paths = [
        ...new Set([
          ...(existing?.workspacePaths ?? []),
          ...(input.workspacePaths ?? []),
        ]),
      ].filter(isUsableWorkspacePath);
      this.query(
        `INSERT INTO sessions (id,tool,native_id,author_id,cwd,workspaces,started_at,last_seen,transcript_path,automatic_since)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        cwd=CASE WHEN ? THEN excluded.cwd ELSE sessions.cwd END, workspaces=excluded.workspaces, started_at=MIN(sessions.started_at,excluded.started_at),
        transcript_path=COALESCE(excluded.transcript_path,sessions.transcript_path), automatic_since=COALESCE(excluded.automatic_since,sessions.automatic_since)`,
      ).run(
        id,
        input.tool,
        nativeId,
        authorId,
        input.cwd && isUsableWorkspacePath(input.cwd) ? input.cwd : null,
        JSON.stringify(paths),
        input.startedAt ?? now,
        input.startedAt ?? now,
        input.transcriptPath ?? null,
        input.automaticSince ?? null,
        input.cwd !== undefined ? 1 : 0,
      );
    }).immediate();
    return this.session(id)!;
  }

  session(id: string): HistorySession | undefined {
    const row = this.query('SELECT * FROM sessions WHERE id=?').get(id) as Row | null;
    return row ? this.sessionFromRow(row) : undefined;
  }
  private sessionFromRow(r: Row): HistorySession {
    return {
      id: r.id,
      tool: r.tool,
      nativeSessionId: r.native_id,
      ...(r.tool === 'claude-code' && r.native_id.includes(':agent:')
        ? { parentNativeSessionId: r.native_id.split(':agent:')[0] }
        : {}),
      authorId: this.effectiveAuthor(r.author_id),
      cwd: r.cwd && isUsableWorkspacePath(r.cwd) ? r.cwd : null,
      workspacePaths: JSON.parse(r.workspaces).filter(isUsableWorkspacePath),
      startedAt: r.started_at,
      lastSeenAt: r.last_seen,
      endedAt: r.ended_at ?? undefined,
      currentTurnId: r.current_turn ?? undefined,
      transcriptPath: r.transcript_path ?? undefined,
      automaticSince: r.automatic_since ?? undefined,
    };
  }
  sessions(): HistorySession[] {
    return (
      this.query('SELECT * FROM sessions ORDER BY last_seen DESC, id').all() as Row[]
    ).map((r) => this.sessionFromRow(r));
  }
  workSessions(selection?: HistorySelection): HistorySession[] {
    const ids = selection
      ? new Set(
          this.records(selection)
            .filter((r) => r.kind !== 'audit')
            .map((r) => r.sessionId),
        )
      : new Set(
          (
            this.query(
              "SELECT DISTINCT session_id FROM records WHERE kind!='audit'",
            ).all() as Row[]
          ).map((r) => r.session_id),
        );
    return this.sessions().filter((s) => ids.has(s.id));
  }
  endSession(id: string, at?: string): void {
    this.query('UPDATE sessions SET ended_at=COALESCE(?,last_seen) WHERE id=?').run(
      at ?? null,
      id,
    );
  }
  setCurrentTurn(sessionId: string, turnId: string): void {
    this.query('UPDATE sessions SET current_turn=? WHERE id=?').run(turnId, sessionId);
  }
  authorName(id: string): string {
    return String(
      (this.query('SELECT name FROM authors WHERE id=?').get(id) as Row | null)?.name ??
        id,
    );
  }

  object(ref: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid content address.');
    return (this.query('SELECT content FROM objects WHERE hash=?').get(ref) as Row | null)
      ?.content;
  }
  private putObject(content: string): string {
    const hash = digest(content);
    this.query('INSERT OR IGNORE INTO objects(hash,content) VALUES (?,?)').run(
      hash,
      content,
    );
    return hash;
  }
  record(id: string): HistoryRecord | undefined {
    const row = this.query('SELECT * FROM records WHERE id=?').get(id) as Row | null;
    return row ? this.hydrate(row) : undefined;
  }
  bySource(sessionId: string, sourceId: string): HistoryRecord | undefined {
    const row = this.query(
      'SELECT r.* FROM source_aliases a JOIN records r ON r.id=a.record_id WHERE a.session_id=? AND a.source_id=?',
    ).get(sessionId, sourceId) as Row | null;
    const ancestor =
      !row && this.repairSchema
        ? (this.query(
            'SELECT r.* FROM ancestor_aliases a JOIN records r ON r.id=a.record_id WHERE a.session_id=? AND a.source_id=?',
          ).get(sessionId, sourceId) as Row | null)
        : null;
    const found = row || ancestor ? this.hydrate(row ?? ancestor!) : undefined;
    return found?.duplicateOf ? this.record(found.duplicateOf) : found;
  }
  alias(sessionId: string, sourceId: string, recordId: string): void {
    const record = this.record(recordId);
    if (!record || record.sessionId !== sessionId)
      throw new Error('Source alias must reference a record in the same session.');
    this.query(
      'INSERT INTO source_aliases VALUES (?,?,?) ON CONFLICT(session_id,source_id) DO UPDATE SET record_id=excluded.record_id',
    ).run(sessionId, sourceId, recordId);
  }
  private hydrate(r: Row): HistoryRecord {
    const payload = JSON.parse(r.payload);
    const { textRef, diffRef, conversationRef, ...rest } = payload;
    return {
      ...rest,
      id: r.id,
      sessionId: r.session_id,
      sequence: r.seq,
      ts: r.ts,
      capturedAt: r.captured_at,
      kind: r.kind,
      turnId: r.turn_id ?? undefined,
      sourceId: r.source_id ?? undefined,
      ...(textRef ? { text: this.object(textRef) ?? '[captured content missing]' } : {}),
      ...(diffRef ? { diff: this.object(diffRef) ?? '[captured diff missing]' } : {}),
      ...(conversationRef
        ? { conversationEvent: JSON.parse(this.object(conversationRef) ?? 'null') }
        : {}),
      prev: r.prev,
      hash: r.hash,
      supersedesId: r.supersedes_id ?? undefined,
      redacted: r.redacted,
      ...this.overlays().get(r.id),
    };
  }

  append(
    sessionId: string,
    input: RecordInput,
    options: { continueCapture?: () => boolean } = {},
  ): { record?: HistoryRecord; inserted: boolean } {
    const settings = historySettings();
    if (
      input.kind === 'prompt' &&
      (input.origin === 'agent' ||
        input.origin === 'harness' ||
        (input.origin !== 'human' && isSyntheticPrompt(input.text ?? '')))
    ) {
      input = {
        ...input,
        kind: 'tool_call',
        origin: 'harness',
        toolName: 'Provider message',
      };
    }
    if (input.file && !isUsableWorkspacePath(input.file)) {
      input = {
        ...input,
        text: input.text ?? `Unresolved provider file path: ${input.file}`,
        file: undefined,
        unresolvedPath: true,
      };
    }
    if (
      (input.kind === 'ai_output' && settings.captureAiOutput === false) ||
      (input.kind === 'tool_call' && settings.captureToolCalls === false)
    )
      return { inserted: false };
    if (
      input.file &&
      (containsPath(this.home, input.file) || isSensitivePath(input.file))
    )
      return { inserted: false };
    if (input.conversationEvent) {
      const e = input.conversationEvent;
      const always = e.toolName && ALWAYS_CAPTURE_TOOLS.has(e.toolName.toLowerCase());
      if (
        !always &&
        ((e.type === 'assistant_text' && settings.captureAiOutput === false) ||
          ((e.type === 'tool_use' || e.type === 'tool_result') &&
            settings.captureToolCalls === false))
      )
        return { inserted: false };
    }
    return this.transaction(() => {
      if (options.continueCapture?.() === false) return { inserted: false };
      const session = this.session(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}.`);
      const {
        id: requestedId,
        kind,
        ts,
        sourceId,
        turnId: requestedTurn,
        text,
        diff,
        conversationEvent,
        ...metadata
      } = input;
      const clean: Row = { ...metadata };
      let redacted = 0;
      const scrub = (value: string): string => {
        const result = redact(value, settings.redact);
        redacted += result.hits;
        return result.text;
      };
      if (text !== undefined) clean.textRef = this.putObject(scrub(text));
      if (diff !== undefined && settings.captureCode !== false)
        clean.diffRef = this.putObject(scrub(diff));
      if (conversationEvent) {
        const safe = withholdSensitiveParts(conversationEvent, settings);
        // Redact values independently: regexes must never damage JSON escaping.
        const visit = (v: any): any =>
          typeof v === 'string'
            ? scrub(v)
            : Array.isArray(v)
              ? v.map(visit)
              : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]))
                : v;
        clean.conversationRef = this.putObject(canonical(visit(safe)));
      }
      // Supplemental observations point at a native edit. Replaying the
      // supplement must supersede its own row, never the edit it points to.
      const observationRow =
        sourceId && input.duplicateOf
          ? (this.query(
              'SELECT * FROM records WHERE session_id=? AND source_id=? ORDER BY seq DESC LIMIT 1',
            ).get(sessionId, sourceId) as Row | null)
          : undefined;
      const prior = sourceId
        ? input.duplicateOf
          ? observationRow
            ? this.hydrate(observationRow)
            : undefined
          : this.bySource(sessionId, sourceId)
        : undefined;
      // A transcript enriches the same captured event; it must retain the original
      // import provenance and metadata the provider does not repeat.
      if (prior)
        for (const [key, value] of Object.entries(this.payload(prior.id)))
          if (
            clean[key] === undefined &&
            !['textRef', 'diffRef', 'conversationRef'].includes(key)
          )
            clean[key] = value;
      const payload = canonical(clean);
      if (prior?.transcriptFinal === true && input.transcriptFinal !== true)
        return { record: prior, inserted: false };
      let turnId =
        requestedTurn ??
        (kind === 'prompt'
          ? undefined
          : input.requestId
            ? (this.bySource(sessionId, `prompt:${input.requestId}`)?.turnId ??
              session.currentTurnId)
            : session.currentTurnId);
      if (
        prior &&
        prior.kind === kind &&
        canonical(this.payload(prior.id)) === payload &&
        (kind === 'prompt' || (prior.turnId ?? null) === (turnId ?? null))
      )
        return { record: prior, inserted: false };
      const id =
        requestedId && !this.record(requestedId) ? requestedId : `rec_${randomUUID()}`;
      if (kind === 'prompt') turnId = prior?.turnId ?? prior?.id ?? id;
      const tail = this.query(
        'SELECT seq,hash FROM records WHERE session_id=? ORDER BY seq DESC LIMIT 1',
      ).get(sessionId) as Row | null;
      const sequence = (tail?.seq ?? 0) + 1;
      const capturedAt = new Date().toISOString();
      if (ts && !Number.isFinite(Date.parse(ts)))
        throw new Error('Record timestamp must be a valid ISO date.');
      const timestamp = ts ? new Date(ts).toISOString() : capturedAt;
      const header = {
        id,
        sessionId,
        sequence,
        ts: timestamp,
        capturedAt,
        kind,
        turnId: turnId ?? null,
        sourceId: sourceId ?? null,
        payload: clean,
        prev: tail?.hash ?? null,
        supersedesId: prior?.id ?? null,
        redacted,
      };
      const hash = digest(canonical(header));
      this.query('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id,
        sessionId,
        sequence,
        timestamp,
        capturedAt,
        kind,
        turnId ?? null,
        sourceId ?? null,
        payload,
        tail?.hash ?? null,
        hash,
        prior?.id ?? null,
        redacted,
      );
      if (prior)
        this.query(
          'UPDATE source_aliases SET record_id=? WHERE session_id=? AND record_id=?',
        ).run(id, sessionId, prior.id);
      if (sourceId) this.alias(sessionId, sourceId, id);
      if (kind === 'prompt') this.setCurrentTurn(sessionId, turnId!);
      this.query(
        'UPDATE sessions SET last_seen=MAX(last_seen,?), ended_at=NULL WHERE id=?',
      ).run(timestamp, sessionId);
      if (input.provenance)
        this.query('INSERT OR IGNORE INTO imports VALUES (?,?,?)').run(
          input.provenance.source,
          input.provenance.id,
          id,
        );
      this.inferProjects(session, { ...input, id, turnId });
      return { record: this.record(id)!, inserted: true };
    }).immediate();
  }
  private payload(id: string): Row {
    return JSON.parse(
      (this.query('SELECT payload FROM records WHERE id=?').get(id) as Row).payload,
    );
  }

  records(
    selection: HistorySelection = { kind: 'all' },
    options: { sessionId?: string; includeSuperseded?: boolean } = {},
  ): HistoryRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    const turn = this.repairSchema
      ? "COALESCE(json_extract(o.patch,'$.turnId'),r.turn_id,r.id)"
      : 'COALESCE(r.turn_id,r.id)';
    if (!options.includeSuperseded)
      where.push(
        this.repairSchema
          ? "COALESCE(json_extract(o.patch,'$.duplicateOf'),json_extract(r.payload,'$.duplicateOf')) IS NULL"
          : "json_extract(r.payload,'$.duplicateOf') IS NULL",
      );
    if (!options.includeSuperseded)
      where.push(
        'NOT EXISTS (SELECT 1 FROM records newer WHERE newer.supersedes_id=r.id)',
      );
    if (options.sessionId) {
      where.push('r.session_id=?');
      args.push(options.sessionId);
    }
    if (selection.kind === 'sessions') {
      if (!selection.sessionIds.length) return [];
      where.push(`r.session_id IN (${selection.sessionIds.map(() => '?').join(',')})`);
      args.push(...selection.sessionIds);
    }
    if (selection.kind === 'project') {
      where.push(
        `EXISTS (SELECT 1 FROM turn_projects p WHERE p.turn_id=${turn} AND p.project_id=? AND (p.origin='manual' OR NOT EXISTS (SELECT 1 FROM manual_turns m WHERE m.turn_id=p.turn_id)))`,
      );
      args.push(selection.projectId);
    }
    if (selection.tool) {
      where.push('s.tool=?');
      args.push(selection.tool);
    }
    if (selection.since) {
      where.push('r.ts>=?');
      args.push(selection.since);
    }
    if (selection.until) {
      where.push('r.ts<=?');
      args.push(selection.until);
    }
    return (
      this.query(
        `SELECT r.* FROM records r JOIN sessions s ON s.id=r.session_id ${this.repairSchema ? 'LEFT JOIN record_overlays o ON o.record_id=r.id' : ''} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.ts,r.session_id,r.seq`,
      ).all(...args) as Row[]
    ).map((r) => this.hydrate(r));
  }

  private inferProjects(
    session: HistorySession,
    record: RecordInput & { id: string },
  ): void {
    if (record.unresolvedPath) return;
    const group = record.turnId ?? record.id;
    if (record.kind !== 'prompt' && record.kind !== 'edit') return;
    const workspaces = (record.context?.workspacePaths ?? session.workspacePaths).filter(
      isUsableWorkspacePath,
    );
    const roots = record.file
      ? [workspaceRoot(dirname(record.file), workspaces)]
      : record.context?.cwd && isUsableWorkspacePath(record.context.cwd)
        ? [workspaceRoot(record.context.cwd, workspaces)]
        : workspaces.length === 1
          ? [workspaceRoot(workspaces[0]!, workspaces)]
          : session.cwd
            ? [workspaceRoot(session.cwd, workspaces)]
            : [];
    if (!record.file && !roots.some((root) => repositoryIdentity(root))) {
      const prior = this.query(
        `SELECT r.id,COALESCE(json_extract(o.patch,'$.turnId'),r.turn_id) AS turn_id FROM records r
         LEFT JOIN record_overlays o ON o.record_id=r.id
         WHERE r.session_id=? AND COALESCE(json_extract(o.patch,'$.kind'),r.kind)='prompt'
         AND json_extract(o.patch,'$.duplicateOf') IS NULL AND r.id!=? AND r.ts<=?
         AND NOT EXISTS(SELECT 1 FROM records n WHERE n.supersedes_id=r.id)
         ORDER BY r.ts DESC,r.seq DESC LIMIT 1`,
      ).get(session.id, record.id, record.ts ?? new Date().toISOString()) as Row | null;
      if (prior) {
        const memberships = this.query(
          'SELECT DISTINCT p.project_id FROM turn_projects p WHERE p.turn_id=?',
        ).all(prior.turn_id ?? prior.id) as Row[];
        if (memberships.length) {
          for (const p of memberships)
            this.query("INSERT OR IGNORE INTO turn_projects VALUES (?,?,'context')").run(
              group,
              p.project_id,
            );
          return;
        }
      }
    }
    // A provider scratch file is evidence within the current turn, not a project.
    if (
      record.file &&
      /[\\/]scratchpad[\\/]/i.test(record.file) &&
      !roots.some((root) => repositoryIdentity(root))
    )
      return;
    if (record.file)
      this.query("DELETE FROM turn_projects WHERE turn_id=? AND origin='context'").run(
        group,
      );
    for (const root of roots) {
      if (containsPath(this.home, root) || pathIdentity(root) === pathIdentity(homedir()))
        continue;
      const project = this.registerProject(root);
      this.query('INSERT OR IGNORE INTO turn_projects VALUES (?,?,?)').run(
        group,
        project.projectId,
        record.file ? 'edit' : 'context',
      );
    }
  }
  registerProject(root: string, name?: string, legacyId?: string): ProjectView {
    if (!isUsableWorkspacePath(root))
      throw new Error(
        'INVALID_PROJECT_PATH: workspace paths must be absolute file-system paths.',
      );
    const key = pathIdentity(root);
    const old = this.query('SELECT project_id FROM project_roots WHERE key=?').get(
      key,
    ) as Row | null;
    const repo = !old && !legacyId ? repositoryIdentity(root) : undefined;
    const sibling = repo
      ? (this.query('SELECT project_id,path FROM project_roots').all() as Row[]).find(
          (r) => repositoryIdentity(r.path) === repo,
        )
      : undefined;
    const id =
      old?.project_id ?? sibling?.project_id ?? legacyId ?? `prj_${randomUUID()}`;
    this.query('INSERT OR IGNORE INTO projects VALUES (?,?)').run(
      id,
      name || basename(root) || root,
    );
    if (name) this.query('UPDATE projects SET name=? WHERE id=?').run(name, id);
    this.query('INSERT OR IGNORE INTO project_roots VALUES (?,?,?,?)').run(
      id,
      resolve(root),
      key,
      sibling ? 0 : 1,
    );
    if (!old || name) this.projectCache = undefined;
    return this.projects().find((p) => p.projectId === id)!;
  }
  projects(): ProjectView[] {
    if (this.projectCache) return this.projectCache;
    return (this.projectCache = (
      this.query('SELECT * FROM projects ORDER BY name,id').all() as Row[]
    ).flatMap((p) => {
      const roots = (
        this.query(
          'SELECT path,current FROM project_roots WHERE project_id=? ORDER BY current DESC,path',
        ).all(p.id) as Row[]
      ).filter((r) => isUsableWorkspacePath(r.path));
      if (!roots.length) return [];
      return [
        {
          projectId: p.id,
          displayName: p.name,
          roots: roots.map((r) => r.path),
          projectRoot: roots.find((r) => r.current)?.path ?? null,
        },
      ];
    }));
  }
  resolveProject(selector: string): ProjectView {
    selector = this.meta(`projectAlias:${selector}`) ?? selector;
    const projects = this.projects();
    const identified = projects.find((p) => p.projectId === selector);
    if (identified) return identified;
    const named = projects.filter(
      (p) => p.displayName.toLowerCase() === selector.toLowerCase(),
    );
    const key = named.length ? undefined : pathIdentity(selector);
    const root = key
      ? (this.query('SELECT project_id FROM project_roots WHERE key=?').get(
          key,
        ) as Row | null)
      : null;
    const exact = root ? projects.filter((p) => p.projectId === root.project_id) : [];
    const containing =
      !named.length && isAbsolute(selector) ? this.projectForPath(selector) : undefined;
    const matches = exact.length ? exact : containing ? [containing] : named;
    if (matches.length !== 1)
      throw Object.assign(
        new Error(
          matches.length
            ? 'AMBIGUOUS_PROJECT: choose a project ID.'
            : `PROJECT_NOT_FOUND: ${selector}`,
        ),
        { candidates: matches },
      );
    return matches[0]!;
  }
  projectForPath(path: string): ProjectView | undefined {
    const key = pathIdentity(path);
    const views = new Map(this.projects().map((p) => [p.projectId, p]));
    const matches = (
      this.query('SELECT project_id,key,path FROM project_roots').all() as Row[]
    )
      .filter(
        (r) =>
          views.has(r.project_id) &&
          isUsableWorkspacePath(r.path) &&
          (key === r.key ||
            key.startsWith(
              r.key.endsWith(process.platform === 'win32' ? '\\' : '/')
                ? r.key
                : r.key + (process.platform === 'win32' ? '\\' : '/'),
            )),
      )
      .map((r) => ({ p: views.get(r.project_id)!, length: r.key.length }));
    matches.sort((a, b) => b.length - a.length);
    return matches[0]?.p;
  }
  relinkProject(id: string, path: string): ProjectView {
    if (!isUsableWorkspacePath(path))
      throw new Error(
        'INVALID_PROJECT_PATH: workspace paths must be absolute file-system paths.',
      );
    const project = this.resolveProject(id);
    this.transaction(() => {
      const existing = this.projectForPath(path);
      if (existing && existing.projectId !== project.projectId)
        throw new Error(
          'PROJECT_PATH_CONFLICT: the new path already belongs to another view.',
        );
      this.query('UPDATE project_roots SET current=0 WHERE project_id=?').run(
        project.projectId,
      );
      this.query(
        'INSERT INTO project_roots VALUES (?,?,?,1) ON CONFLICT(key) DO UPDATE SET current=1',
      ).run(project.projectId, resolve(path), pathIdentity(path));
    }).immediate();
    this.projectCache = undefined;
    return this.resolveProject(project.projectId);
  }
  assign(selector: string, projectIds: string[]): void {
    const projects = projectIds.map((id) => this.resolveProject(id));
    const records = this.session(selector)
      ? this.records({ kind: 'all' }, { sessionId: selector })
      : [this.record(selector)].filter((r): r is HistoryRecord => !!r);
    if (!records.length) throw new Error(`WORK_NOT_FOUND: ${selector}`);
    this.transaction(() => {
      for (const turn of new Set(records.map((r) => r.turnId ?? r.id))) {
        this.query('INSERT OR IGNORE INTO manual_turns VALUES (?)').run(turn);
        this.query("DELETE FROM turn_projects WHERE turn_id=? AND origin='manual'").run(
          turn,
        );
        for (const project of projects)
          this.query("INSERT INTO turn_projects VALUES (?,?,'manual')").run(
            turn,
            project.projectId,
          );
      }
    }).immediate();
  }
  importRecord(source: string, id: string): HistoryRecord | undefined {
    const row = this.query(
      'SELECT record_id FROM imports WHERE source=? AND source_id=?',
    ).get(source, id) as Row | null;
    const original = row ? this.record(row.record_id) : undefined;
    return original?.sourceId
      ? (this.bySource(original.sessionId, original.sourceId) ?? original)
      : original;
  }
  noteImport(source: string, id: string, recordId: string): void {
    this.query('INSERT OR IGNORE INTO imports VALUES (?,?,?)').run(source, id, recordId);
  }
  meta(key: string): string | undefined {
    return (this.query('SELECT value FROM meta WHERE key=?').get(key) as Row | null)
      ?.value;
  }
  setMeta(key: string, value: string): void {
    this.query(
      'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  }

  verify(): { ok: boolean; checks: { name: string; ok: boolean; details: string[] }[] } {
    const checks: { name: string; ok: boolean; details: string[] }[] = [];
    const integrity = this.query('PRAGMA integrity_check').all() as Row[];
    checks.push({
      name: 'database',
      ok: integrity.every((r) => Object.values(r)[0] === 'ok'),
      details: integrity.map((r) => String(Object.values(r)[0])),
    });
    const foreign = this.query('PRAGMA foreign_key_check').all();
    checks.push({
      name: 'references',
      ok: !foreign.length,
      details: foreign.map((r) => canonical(r)),
    });
    const objects = this.query('SELECT * FROM objects').all() as Row[];
    const badObjects = objects
      .filter((r) => digest(r.content) !== r.hash)
      .map((r) => r.hash);
    checks.push({ name: 'content', ok: !badObjects.length, details: badObjects });
    const badChains: string[] = [];
    for (const session of this.sessions()) {
      let prev: string | null = null;
      let seq = 0;
      for (const r of this.query(
        'SELECT * FROM records WHERE session_id=? ORDER BY seq',
      ).all(session.id) as Row[]) {
        const header = {
          id: r.id,
          sessionId: r.session_id,
          sequence: r.seq,
          ts: r.ts,
          capturedAt: r.captured_at,
          kind: r.kind,
          turnId: r.turn_id,
          sourceId: r.source_id,
          payload: JSON.parse(r.payload),
          prev: r.prev,
          supersedesId: r.supersedes_id,
          redacted: r.redacted,
        };
        if (r.prev !== prev || r.seq !== ++seq || digest(canonical(header)) !== r.hash)
          badChains.push(r.id);
        for (const key of ['textRef', 'diffRef', 'conversationRef']) {
          const ref = header.payload[key];
          if (ref && !this.query('SELECT 1 FROM objects WHERE hash=?').get(ref))
            badChains.push(`${r.id}:missing-${key}`);
        }
        prev = r.hash;
      }
    }
    checks.push({ name: 'history-chains', ok: !badChains.length, details: badChains });
    if (this.repairSchema) {
      const bad: string[] = [];
      for (const row of this.query('SELECT * FROM repair_receipts').all() as Row[]) {
        const operations = JSON.parse(row.payload).operations;
        if (
          !operations ||
          row.id !== 'repair_' + digest(canonical(operations)).slice(0, 32)
        )
          bad.push(row.id);
      }
      const receipts = new Map(
        (this.query('SELECT * FROM repair_receipts').all() as Row[]).map((r) => [
          r.id,
          JSON.parse(r.payload).operations,
        ]),
      );
      for (const r of this.query('SELECT * FROM record_overlays').all() as Row[]) {
        const o = receipts
          .get(r.repair_id)
          ?.overlays?.find((o: any) => o.id === r.record_id);
        if (!o || canonical(o.patch) !== canonical(JSON.parse(r.patch)))
          bad.push(r.record_id);
      }
      for (const r of this.query('SELECT * FROM author_overrides').all() as Row[]) {
        if (
          !receipts
            .get(r.repair_id)
            ?.authors?.some((a: any) => a.source === r.source && a.target === r.target)
        )
          bad.push(r.source);
      }
      for (const r of this.query('SELECT * FROM ancestor_aliases').all() as Row[]) {
        if (
          !receipts
            .get(r.repair_id)
            ?.bindings?.some(
              (a: any) =>
                a.ancestor &&
                a.sessionId === r.session_id &&
                a.sourceId === r.source_id &&
                a.recordId === r.record_id,
            )
        )
          bad.push(r.source_id);
      }
      checks.push({ name: 'repair-receipts', ok: !bad.length, details: bad });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }
}

export function historyExists(): boolean {
  return existsSync(dataPath('history.sqlite'));
}
export function pendingCount(): number {
  const dir = dataPath('pending');
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json')).length
    : 0;
}
