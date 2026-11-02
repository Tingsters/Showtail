/**
 * Parse and discover VS Code **native Copilot Chat** session files.
 *
 * Copilot Chat persists every native session (the normal chat box, not the
 * `@showtail` participant) to disk under
 * `…/Code/User/workspaceStorage/<hash>/chatSessions/<id>.{json,jsonl}`, with a
 * sibling `…/workspaceStorage/<hash>/workspace.json` mapping the opaque `<hash>`
 * to the project folder it was opened for. (No-folder "empty window" chats go to
 * `…/globalStorage/emptyWindowChatSessions/<id>.jsonl` instead — those are routed
 * by edited-file path, see `import copilot --auto`.)
 *
 * This is what makes native Copilot Chat capturable at all. The VS Code extension
 * API does NOT expose native chat to third parties (a real privacy boundary), but
 * the on-disk transcript is plain JSON — so both `showtail import copilot` and the
 * extension's live watcher read these files rather than the (unavailable) live API.
 *
 * TWO on-disk shapes, both handled by {@link reconstructSession}:
 *   - **Current (VS Code ≥ ~1.103)** — a `.jsonl` **patch journal**, one delta per
 *     line: `{"kind":0,"v":{…session…}}` is the initial snapshot, then
 *     `{"kind":1,"k":[path…],"v":val}` **sets** a value at a path and
 *     `{"kind":2,"k":[path…],"v":[…]}` **appends** array items at a path (e.g.
 *     `k:["requests"]` adds a turn; `k:["requests",2,"response"]` appends streamed
 *     reply parts). We replay the deltas to rebuild the final session object.
 *   - **Legacy** — a single `.json` document with a top-level `requests[]`.
 *
 * Either way the reconstructed session has the same `requests[]` schema, read by
 * {@link parseCopilotSession}:
 *   - `requests[].message.text`            — the user's typed prompt.
 *   - `requests[].requestId` / `timestamp` — stable per-turn id + epoch-ms time.
 *   - `requests[].agent.extensionId.value` — the answering agent (our own
 *                                            `@showtail` participant is skipped).
 *   - `requests[].response[]`              — the streamed reply: items with NO
 *                                            `kind` are markdown (`{ value }`);
 *                                            `kind:'textEditGroup'` names edited
 *                                            files (`uri.fsPath`, `edits`);
 *                                            `kind:'thinking'` is dropped.
 *   - `requests[].result.metadata.toolCallRounds[].response` — reply-text fallback.
 *
 * Antigravity (a VS Code fork) is captured separately: it replaced the chat backend
 * with Gemini and writes a different "brain" transcript, so it has its own reader
 * (`antigravityCliTranscript.ts`). Only the import/routing machinery is shared.
 *
 * Everything is local and best-effort: malformed requests are skipped, while an
 * unsupported or malformed file reconstructs as empty and is never thrown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDecisionQuestions,
  renderDecisionText,
  type DecisionQuestion,
} from './decisions.ts';
import { asArray, asNumber, asString, isObject, prop } from './parse.ts';
import { toRepoRelative } from '@showtail/agent-traces/paths/pathUtil';
import type { EditedFile } from './hookInput.ts';
import type { HookTranscriptEvent } from '../plugins/types.ts';
import type { JsonValue } from '../types.ts';
type LedgerProjectAttachment = { kind: 'file' | 'folder'; path: string };
type LedgerProjectControlAction = 'report' | 'open_report' | 'status' | 'verify';
interface LedgerProjectControlInput {
  claimId: string;
  action: LedgerProjectControlAction;
  trailId: string;
  root: string;
  displayName?: string;
  mode: 'authoritative' | 'corroborated';
  evidence: string[];
  crossWorkspace?: boolean;
  reportPath?: string;
}

export const SHOWTAIL_PROJECT_CONTROL_PROTOCOL = 'showtail-project-control/v1';

/** A normalized message recovered from a Copilot Chat session. */
export interface CopilotMessage {
  /**
   * "user" (typed prompt), "assistant" (text reply), "edit" (a file changed),
   * "plan" (a `manage_todo_list` checklist), or "decision" (a `vscode_askQuestions`
   * choice). Mirrors Codex's message roles so the report renders identical cards.
   */
  role: 'user' | 'assistant' | 'edit' | 'plan' | 'decision';
  text: string;
  /** ISO-8601 timestamp derived from the request's epoch-ms `timestamp`, if present. */
  timestamp?: string;
  /** A stable id so re-imports (and the live watcher) dedupe. */
  sourceId: string;
  /** Native request id shared by the prompt and every child of this turn. */
  requestId?: string;
  /** True when Copilot persisted `request.result`, its completed-response marker. */
  isFinal?: boolean;
  /** Explicit student attachments on this exact native request. */
  attachments?: LedgerProjectAttachment[];
  /** Validated result from Showtail's registered local project-control tool. */
  projectControl?: LedgerProjectControlInput;
  /** For edits: the repo-relative file path(s) Copilot touched. */
  files?: string[];
  /** For edits: best-effort per-file diffs (added lines) so they render like Claude's. */
  edits?: EditedFile[];
}

/** A normalized session: the messages we care about, in order. */
export interface CopilotTranscript {
  sessionId?: string;
  title: string;
  messages: CopilotMessage[];
  events: HookTranscriptEvent[];
}

/** Automatic recovery options. Explicit imports omit these and keep full history. */
export interface CopilotAutomaticCaptureOptions {
  includeOutsideEdits?: boolean;
  automaticCaptureSince?: string;
}

/** A chat-session file found on disk. */
export interface CopilotSessionInfo {
  path: string;
  /** The Copilot chat session id (the file's basename, sans extension). */
  sessionId: string;
  mtimeMs: number;
  cwd?: string;
}

/** An at-a-glance summary of one session, for the import picker / `--list`. */
export interface CopilotSessionSummary {
  info: CopilotSessionInfo;
  promptCount: number;
  editCount: number;
  firstPrompt: string;
  lastPrompt: string;
  first?: string;
  last?: string;
  importState: 'none' | 'partial' | 'full';
}

/** One file Copilot edited, with an ABSOLUTE path — for `--auto` edit-path routing. */
export interface CopilotAbsEdit {
  absPath: string;
  /** Best-effort added-line diff. */
  diff: string;
  timestamp?: string;
  /** `copilot:edit:<sid>:<requestId>`; the router appends `#<displayPath>`. */
  sourceIdBase: string;
  /** Explicit linkage back to this request's prompt, independent of array order. */
  requestId: string;
  promptSourceId: string;
}

/** A back-dated edit artifact ready to import (display path + stable id). */
export interface CopilotEditArtifact {
  /** Display path (repo-relative or absolute) recorded on the artifact. */
  path: string;
  diff: string;
  timestamp?: string;
  sourceId: string;
  /** The prompt-turn this edit belongs to, so it renders inside that turn. */
  turnId?: string;
}

/** The `<requestId>` tail of a `copilot:<role>:<sid>:<requestId>` source id. */
export function requestIdOf(sourceId: string): string {
  return sourceId.slice(sourceId.lastIndexOf(':') + 1);
}

/** Don't record edits to Showtail/VS Code bookkeeping files. Mirrors hook.ts. */
export function isInternalEditPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|git|vscode)([\\/]|$)/.test(p);
}

/** Our own chat participant — skip it on file import; the extension logs it live. */
function isOwnAgent(extensionId: string | undefined): boolean {
  return (extensionId ?? '').toLowerCase().includes('showtail');
}

function explicitRequestAttachments(request: unknown): LedgerProjectAttachment[] {
  const variables = asArray(prop(prop(request, 'variableData'), 'variables')) ?? [];
  const found = new Map<string, LedgerProjectAttachment>();
  for (const variable of variables) {
    if (!isObject(variable)) continue;
    const kind = asString(prop(variable, 'kind'));
    if (kind !== 'file' && kind !== 'folder') continue;
    if (prop(variable, 'automaticallyAdded') === true) continue;
    const id = asString(prop(variable, 'id')) ?? '';
    if (id.toLowerCase().startsWith('vscode.implicit.')) continue;
    const value = prop(variable, 'value');
    const fsPath =
      asString(prop(value, 'fsPath')) ?? asString(prop(prop(value, 'uri'), 'fsPath'));
    if (!fsPath || !isAbsolute(fsPath) || /[\0\r\n]/.test(fsPath)) continue;
    const path = resolve(fsPath);
    const key = `${kind}\t${process.platform === 'win32' ? path.toLowerCase() : path}`;
    found.set(key, { kind, path });
  }
  return [...found.values()];
}

function optionalMarkerString(
  marker: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null | undefined {
  const value = marker[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    return null;
  }
  return value;
}

/** Parse only the compact JSON emitted by Showtail's registered LM tool. */
export function parseShowtailProjectControlMarker(
  text: string,
): LedgerProjectControlInput | null {
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(marker)) return null;
  if (prop(marker, 'showtailProjectControl') !== SHOWTAIL_PROJECT_CONTROL_PROTOCOL) {
    return null;
  }
  const claimId = asString(prop(marker, 'claimId'));
  const action = asString(prop(marker, 'action'));
  const trailId = asString(prop(marker, 'trailId'));
  const root = asString(prop(marker, 'root'));
  const mode = asString(prop(marker, 'mode'));
  const evidenceRaw = asArray(prop(marker, 'evidence'));
  if (
    !claimId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      claimId,
    ) ||
    (action !== 'report' &&
      action !== 'open_report' &&
      action !== 'status' &&
      action !== 'verify') ||
    !trailId ||
    !/^trl_[A-Za-z0-9_-]+$/.test(trailId) ||
    !root ||
    root !== root.trim() ||
    !isAbsolute(root) ||
    /[\0\r\n]/.test(root) ||
    (mode !== 'authoritative' && mode !== 'corroborated') ||
    !evidenceRaw ||
    evidenceRaw.length === 0 ||
    evidenceRaw.length > 16 ||
    !evidenceRaw.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 80 &&
        !/[\0\r\n]/.test(item),
    )
  ) {
    return null;
  }

  const displayName = optionalMarkerString(marker, 'displayName', 200);
  const reportPath = optionalMarkerString(marker, 'reportPath', 4096);
  if (displayName === null || reportPath === null) return null;
  if (reportPath !== undefined && !isAbsolute(reportPath)) return null;
  const crossWorkspace = prop(marker, 'crossWorkspace');
  if (crossWorkspace !== undefined && typeof crossWorkspace !== 'boolean') return null;

  return {
    claimId,
    action: action as LedgerProjectControlAction,
    trailId,
    root: resolve(root),
    ...(displayName ? { displayName } : {}),
    mode,
    evidence: [...new Set(evidenceRaw as string[])],
    ...(crossWorkspace === undefined ? {} : { crossWorkspace }),
    ...(reportPath ? { reportPath: resolve(reportPath) } : {}),
  };
}

function projectControlFromRequest(
  request: unknown,
): LedgerProjectControlInput | undefined {
  const metadata = prop(prop(request, 'result'), 'metadata');
  const results = prop(metadata, 'toolCallResults');
  let selected: LedgerProjectControlInput | undefined;
  for (const round of asArray(prop(metadata, 'toolCallRounds')) ?? []) {
    for (const call of asArray(prop(round, 'toolCalls')) ?? []) {
      if (asString(prop(call, 'name')) !== 'showtail_project_control') continue;
      const callId = asString(prop(call, 'id'));
      const rawArguments = asString(prop(call, 'arguments'));
      if (!callId || !rawArguments) continue;
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(rawArguments);
      } catch {
        continue;
      }
      const requestedAction = asString(prop(argumentsValue, 'action'));
      const result = prop(results, callId);
      if (prop(result, 'isError') === true) continue;
      for (const part of asArray(prop(result, 'content')) ?? []) {
        const value = asString(prop(part, 'value')) ?? asString(prop(part, 'text'));
        if (!value) continue;
        const marker = parseShowtailProjectControlMarker(value);
        if (marker && marker.action === requestedAction) selected = marker;
      }
    }
  }
  return selected;
}

// --- Locating sessions on disk ---------------------------------------------

/**
 * The `…/User` dirs VS Code (stable + Insiders) keeps `workspaceStorage` under,
 * across platforms. A `SHOWTAIL_VSCODE_STORAGE` override (a single
 * `workspaceStorage` dir) takes precedence — used by tests and unusual installs.
 */
export function copilotWorkspaceStorageDirs(): string[] {
  const override = process.env.SHOWTAIL_VSCODE_STORAGE;
  if (override && override.length > 0) return [override];

  const home = homedir();
  const apps = ['Code', 'Code - Insiders'];
  let userDirs: string[];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    userDirs = apps.map((a) => join(appData, a, 'User'));
  } else if (process.platform === 'darwin') {
    userDirs = apps.map((a) => join(home, 'Library', 'Application Support', a, 'User'));
  } else {
    const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    userDirs = apps.map((a) => join(config, a, 'User'));
  }
  return userDirs.map((d) => join(d, 'workspaceStorage')).filter((d) => existsSync(d));
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A chat-session file is either the new `.jsonl` journal or a legacy `.json` doc. */
function isChatSessionFile(entry: string): boolean {
  return entry.endsWith('.jsonl') || entry.endsWith('.json');
}

/** Decode a `workspaceStorage/<hash>/workspace.json` into the folder path it maps to. */
function workspaceFolder(storageDir: string): string | null {
  const file = join(storageDir, 'workspace.json');
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  // Single-folder workspaces carry `folder` (a `file://` URI). Multi-root
  // `.code-workspace` files carry `workspace` instead; we only route single
  // folders (the common case), so a multi-root session is simply skipped.
  const uri = asString(prop(obj, 'folder'));
  if (!uri) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Normalize two absolute paths for comparison (separators + win32 case). */
function normPath(p: string): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * Find every Copilot chat-session file whose workspace folder is `root`, newest
 * first. Reads each `workspace.json` (cheap) to map storage hash → folder, then
 * lists that storage's `chatSessions/*.{json,jsonl}`.
 */
export function findChatSessions(): CopilotSessionInfo[] {
  const out: CopilotSessionInfo[] = [];
  for (const base of copilotWorkspaceStorageDirs()) {
    for (const hash of safeReaddir(base)) {
      const storageDir = join(base, hash);
      const folder = workspaceFolder(storageDir);
      if (!folder) continue;
      const chatDir = join(storageDir, 'chatSessions');
      for (const entry of safeReaddir(chatDir)) {
        if (!isChatSessionFile(entry)) continue;
        const full = join(chatDir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({
          path: full,
          sessionId: entry.replace(/\.jsonl?$/, ''),
          mtimeMs: st.mtimeMs,
          cwd: folder,
        });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function findProjectChatSessions(root: string): CopilotSessionInfo[] {
  const want = normPath(root);
  return findChatSessions().filter(
    (info) => info.cwd !== undefined && normPath(info.cwd) === want,
  );
}

// --- Reconstructing the session (format detect + delta replay) -------------

const SUPPORTED_SESSION_VERSIONS = new Set([3]);
const UNSAFE_DELTA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function supportedSessionState(value: unknown, allowUnversioned: boolean): boolean {
  if (
    !isObject(value) ||
    Array.isArray(value) ||
    !Array.isArray(prop(value, 'requests'))
  ) {
    return false;
  }
  if (prop(value, 'schemaVersion') !== undefined) return false;
  const version = prop(value, 'version');
  return (
    (version === undefined && allowUnversioned) ||
    (typeof version === 'number' && SUPPORTED_SESSION_VERSIONS.has(version))
  );
}

function validDeltaPath(path: unknown[]): path is Array<string | number> {
  return (
    path.length > 0 &&
    path.every(
      (part) =>
        (typeof part === 'string' && part.length > 0 && !UNSAFE_DELTA_KEYS.has(part)) ||
        (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0),
    )
  );
}

/** Walk `path` into `node`, returning the value there or null if unreachable. */
function navTo(node: unknown, path: Array<string | number>): unknown {
  let cur: unknown = node;
  for (const p of path) {
    if (cur == null) return null;
    if (Array.isArray(cur)) {
      if (typeof p !== 'number') return null;
      cur = cur[p];
    } else if (isObject(cur)) {
      if (typeof p !== 'string') return null;
      cur = cur[p];
    } else return null;
  }
  return cur;
}

/** Apply one validated set/append delta to the in-progress session state. */
function applyDelta(
  state: unknown,
  path: Array<string | number>,
  kind: 1 | 2,
  v: unknown,
): boolean {
  const parent = navTo(state, path.slice(0, -1));
  if (parent == null || !isObject(parent)) return false;
  const last = path[path.length - 1]!;
  if (
    (Array.isArray(parent) && typeof last !== 'number') ||
    (!Array.isArray(parent) && typeof last !== 'string')
  ) {
    return false;
  }
  const container = parent as Record<string | number, unknown>;
  try {
    if (kind === 2) {
      // Append array elements at the path (creating the array if absent).
      if (!Array.isArray(v)) return false;
      const cur = container[last];
      if (Array.isArray(cur)) cur.push(...v);
      else if (cur === undefined) container[last] = [...v];
      else return false;
    } else {
      container[last] = v;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a chat-session file's raw content to a single session object, whether
 * it's the legacy single `.json` document or the current `.jsonl` patch journal.
 * For the journal we replay the deltas (kind 0 snapshot → kind 1 set → kind 2
 * append, by path `k`) into the final session. Unknown versions, delta kinds, or
 * malformed journal lines invalidate the reconstruction so partial evidence is
 * never mistaken for a known transcript shape.
 */
export function reconstructSession(content: string): unknown {
  // Legacy single-doc: the whole file is one JSON object with a `requests` array.
  try {
    const whole = JSON.parse(content);
    if (supportedSessionState(whole, true)) return whole;
    if (isObject(whole) && Array.isArray(prop(whole, 'requests'))) return {};
  } catch {
    /* not a single JSON document — fall through to the JSONL replay */
  }

  let state: unknown;
  let sawSnapshot = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return {};
    }
    if (!isObject(o) || Array.isArray(o)) return {};
    const kind = asNumber(prop(o, 'kind'));
    if (kind !== 0 && kind !== 1 && kind !== 2) return {};
    if (!Object.prototype.hasOwnProperty.call(o, 'v')) return {};
    const rawPath = prop(o, 'k');
    const path = rawPath === undefined ? [] : asArray(rawPath);
    if (!path) return {};
    const v = prop(o, 'v');
    if (kind === 0) {
      if (sawSnapshot || path.length !== 0 || !supportedSessionState(v, false)) {
        return {};
      }
      state = v;
      sawSnapshot = true;
      continue;
    }
    if (
      !sawSnapshot ||
      !validDeltaPath(path) ||
      (kind === 2 && !Array.isArray(v)) ||
      !applyDelta(state, path, kind, v)
    ) {
      return {};
    }
  }
  return sawSnapshot && supportedSessionState(state, false) ? state : {};
}

// --- Parsing ---------------------------------------------------------------

/** Read a chat-session file from disk and parse it. */
export function readChatSessionFile(
  path: string,
  root: string,
  options: CopilotAutomaticCaptureOptions = {},
): CopilotTranscript {
  if (!existsSync(path)) throw new Error(`Copilot chat session not found: ${path}`);
  return parseCopilotChatTranscript(readFileSync(path, 'utf8'), root, options);
}

/** epoch-ms → ISO-8601, or undefined for a missing/invalid value. */
function isoFromMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Native Copilot gives every request one base timestamp, then Showtail assigns tiny
 * offsets to its children for display ordering. Apply an automatic-capture cutoff
 * to that base timestamp once so an old request cannot leak through via an offset.
 */
function requestInAutomaticCaptureWindow(
  request: unknown,
  automaticCaptureSince: string | undefined,
): boolean {
  if (!automaticCaptureSince) return true;
  const cutoff = Date.parse(automaticCaptureSince);
  const timestamp = isoFromMs(asNumber(prop(request, 'timestamp')));
  const observed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(cutoff) && Number.isFinite(observed) && observed >= cutoff;
}

/**
 * Assemble the assistant's text reply from a request's `response[]`. The streamed
 * markdown parts have NO `kind` and carry a `value` string. Visible
 * `inlineReference` parts become inline-code labels; edit/tool/thinking internals
 * are skipped. Falls back to joining `result.metadata.toolCallRounds[]` `response`
 * strings when no visible response parts are present.
 */
function inlineReferenceText(part: Record<string, unknown>): string | undefined {
  const reference = prop(part, 'inlineReference');
  const value =
    asString(prop(reference, 'name')) ??
    asString(prop(reference, 'fsPath')) ??
    asString(prop(reference, 'external')) ??
    asString(prop(reference, 'path')) ??
    asString(prop(prop(reference, 'uri'), 'fsPath')) ??
    asString(reference);
  if (!value) return undefined;

  // Choose a delimiter longer than every run inside the label so symbol names
  // containing backticks still render as one inline-code reference.
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function assistantText(request: unknown): string {
  const parts = asArray(prop(request, 'response')) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (prop(part, 'kind') === 'inlineReference') {
      const reference = inlineReferenceText(part);
      if (reference) chunks.push(reference);
      continue;
    }
    if (prop(part, 'kind') !== undefined) continue; // structural / thinking / tool
    const value = asString(prop(part, 'value'));
    if (value) chunks.push(value);
  }
  let text = stripEmptyFences(chunks.join(''));
  if (text) return text;

  // Fallback: the per-round assistant text recorded in result.metadata.
  const rounds = asArray(
    prop(prop(prop(request, 'result'), 'metadata'), 'toolCallRounds'),
  );
  if (rounds) {
    text = stripEmptyFences(
      rounds.map((r) => asString(prop(r, 'response')) ?? '').join(''),
    );
  }
  return text;
}

/**
 * Drop fenced code blocks whose body is empty/whitespace. Copilot streams an inline
 * file edit as the bare opening/closing ``` fence-marker text parts wrapped around a
 * `textEditGroup` part — and we skip that group (the code is captured separately as
 * the edit diff), so the join leaves an empty fence that would render as a blank box.
 * A fence with real content is untouched (`\s*` can't span the code). Then collapse
 * the blank lines those removals leave behind.
 */
function stripEmptyFences(text: string): string {
  return text
    .replace(/```[^\n]*\n\s*```[ \t]*\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The files a request's `textEditGroup` parts touched, with ABSOLUTE `fsPath` and a
 * best-effort added-line diff. We can't recover prior content after the fact, so the
 * diff is the inserted text rendered as `+ ` lines (pure deletions contribute none).
 */
function textEditGroups(request: unknown): { fsPath: string; diff: string }[] {
  const parts = asArray(prop(request, 'response')) ?? [];
  const byFile = new Map<string, string[]>();
  for (const part of parts) {
    if (!isObject(part) || prop(part, 'kind') !== 'textEditGroup') continue;
    const fsPath = asString(prop(prop(part, 'uri'), 'fsPath'));
    if (!fsPath) continue;
    const added: string[] = [];
    // `edits` is an array of edit rounds, each an array of `{ text, range }`.
    for (const round of asArray(prop(part, 'edits')) ?? []) {
      for (const seg of asArray(round) ?? []) {
        const text = asString(prop(seg, 'text'));
        if (text) for (const line of text.split('\n')) added.push('+ ' + line);
      }
    }
    byFile.set(fsPath, (byFile.get(fsPath) ?? []).concat(added));
  }
  return [...byFile].map(([fsPath, lines]) => ({ fsPath, diff: lines.join('\n') }));
}

/** Repo-relative, in-repo, non-internal edits for a request (single-project import). */
function editsFromRequest(
  request: unknown,
  root: string,
  includeOutside = false,
): EditedFile[] {
  const out: EditedFile[] = [];
  for (const g of textEditGroups(request)) {
    const rel = includeOutside ? resolve(root, g.fsPath) : toRepoRelative(root, g.fsPath);
    if ((!includeOutside && rel.startsWith('..')) || isInternalEditPath(rel)) continue;
    out.push({ file: rel, diff: g.diff });
  }
  return out;
}

/**
 * Render a Copilot `manage_todo_list` todo list as a status checklist — the same
 * markdown shape Codex's plans use (`renderCodexPlan`): `completed → [x]`,
 * `in-progress → [→]`, anything else → `[ ]`. Returns undefined for an empty list.
 */
function renderTodoList(todoList: unknown): string | undefined {
  const items = asArray(todoList);
  if (!items || items.length === 0) return undefined;
  const lines: string[] = [];
  for (const item of items) {
    const title = asString(prop(item, 'title'))?.trim();
    if (!title) continue;
    const status = asString(prop(item, 'status'));
    const mark =
      status === 'completed' ? '[x]' : status === 'in-progress' ? '[→]' : '[ ]';
    lines.push(`- ${mark} ${title}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * The plan a request produced via `manage_todo_list`, if any. Copilot calls the
 * tool repeatedly as it works (create, then mark items done); we keep the LAST
 * invocation's list — its most complete state — so a turn shows one evolving plan
 * (like Antigravity's single implementation_plan.md), not one card per micro-update.
 * Returns the rendered checklist, else undefined.
 */
function planFromRequest(request: unknown): string | undefined {
  let last: string | undefined;
  for (const part of asArray(prop(request, 'response')) ?? []) {
    if (!isObject(part) || prop(part, 'kind') !== 'toolInvocationSerialized') continue;
    if (asString(prop(part, 'toolId')) !== 'manage_todo_list') continue;
    const tsd = prop(part, 'toolSpecificData');
    const rendered = renderTodoList(prop(tsd, 'todoList'));
    if (rendered) last = rendered;
  }
  return last;
}

/**
 * Apply a `vscode_askQuestions` result to its parsed questions. The result is
 * `{ answers: { <header>: { selected: [label…], freeText, skipped } } }`, keyed by
 * each question's `header`. `selected` labels mark the chosen options (and become
 * the answer); a `freeText` answer is a typed-in custom choice. Mirrors
 * `parseCodexDecision`'s answer loop, adapted to Copilot's shape.
 */
function applyCopilotAnswers(questions: DecisionQuestion[], answers: unknown): void {
  for (const q of questions) {
    const a = prop(answers, q.header ?? '');
    if (a === undefined) continue;
    const selected = (asArray(prop(a, 'selected')) ?? [])
      .map((x) => asString(x))
      .filter((x): x is string => Boolean(x));
    const freeText = asString(prop(a, 'freeText'))?.trim();
    if (selected.length > 0) {
      q.answer = selected.join(', ');
      let matched = false;
      for (const o of q.options) {
        if (selected.includes(o.label)) {
          o.chosen = true;
          matched = true;
        }
      }
      q.custom = !matched;
    } else if (freeText) {
      q.answer = freeText;
      q.custom = true;
    }
  }
}

/**
 * The `{ <header>: { selected, freeText } }` answer object for a tool call id, from
 * `result.metadata.toolCallResults[id].content[0].value` (a JSON string of
 * `{ answers: {…} }`). Returns undefined when absent/unparseable.
 */
function decisionAnswers(request: unknown, callId: string): unknown {
  const results = prop(prop(prop(request, 'result'), 'metadata'), 'toolCallResults');
  const rec = prop(results, callId);
  const raw = asString(prop(asArray(prop(rec, 'content'))?.[0], 'value'));
  if (!raw) return undefined;
  try {
    return prop(JSON.parse(raw), 'answers');
  } catch {
    return undefined;
  }
}

/**
 * The decisions a request made via `vscode_askQuestions` (VS Code's AskUserQuestion).
 * Each lives in `result.metadata.toolCallRounds[].toolCalls[]` as
 * `{ id, name:'vscode_askQuestions', arguments }` (a JSON string of the same
 * `{ questions:[…] }` shape `parseDecisionQuestions` reads); the chosen answer is in
 * `toolCallResults[id]`. Rendered as Claude/Codex-style decision markdown. Returns
 * `{ text, callId }[]`, skipping malformed calls.
 */
function decisionsFromRequest(request: unknown): { text: string; callId: string }[] {
  const rounds = asArray(
    prop(prop(prop(request, 'result'), 'metadata'), 'toolCallRounds'),
  );
  if (!rounds) return [];
  const out: { text: string; callId: string }[] = [];
  for (const round of rounds) {
    for (const call of asArray(prop(round, 'toolCalls')) ?? []) {
      if (asString(prop(call, 'name')) !== 'vscode_askQuestions') continue;
      const callId = asString(prop(call, 'id'));
      const args = asString(prop(call, 'arguments'));
      if (!callId || !args) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        continue;
      }
      const questions = parseDecisionQuestions(parsed);
      if (questions.length === 0) continue;
      applyCopilotAnswers(questions, decisionAnswers(request, callId));
      out.push({ text: renderDecisionText(questions, 'Copilot'), callId });
    }
  }
  return out;
}

/**
 * Parse a reconstructed Copilot session object into normalized messages. For each
 * request we emit the user's prompt, the assistant's text reply, and any in-repo
 * file edits — each tagged with a stable `sourceId` keyed off the session +
 * `requestId` so the live watcher and a later `import` never double-count. Requests
 * answered by our own `@showtail` participant are skipped (the extension logs those
 * live).
 */
export function parseCopilotSession(
  session: unknown,
  root: string,
  options: CopilotAutomaticCaptureOptions = {},
): CopilotTranscript {
  const sessionId = asString(prop(session, 'sessionId'));
  const requests = asArray(prop(session, 'requests')) ?? [];
  const messages: CopilotMessage[] = [];
  const events: HookTranscriptEvent[] = [];
  let eventSequence = 0;
  const sid = sessionId ?? '?';

  requests.forEach((request, i) => {
    if (!isObject(request)) return;
    if (!requestInAutomaticCaptureWindow(request, options.automaticCaptureSince)) {
      return;
    }
    // `agent.extensionId` is `{ value, _lower }`; key off its `value`.
    const extId = asString(prop(prop(prop(request, 'agent'), 'extensionId'), 'value'));
    if (isOwnAgent(extId)) return;

    const requestId = asString(prop(request, 'requestId')) ?? String(i);
    const isFinal = prop(request, 'result') !== undefined;
    const attachments = explicitRequestAttachments(request);
    const projectControl = projectControlFromRequest(request);
    // A request records ONE epoch-ms `timestamp`, but its parts happen in sequence:
    // the user prompts, Copilot may ask questions (decisions) mid-turn, then replies,
    // then edits. Stamp them with strictly increasing sub-timestamps (tiny ms offsets
    // that stay well inside the request's window — the next request is far later) so
    // the report renders them in real order instead of collapsing on one time, which
    // sank decisions to the bottom of the turn. `tsAt(0)` reproduces the old value.
    const baseMs = asNumber(prop(request, 'timestamp'));
    const tsAt = (offset: number): string | undefined =>
      baseMs === undefined ? undefined : isoFromMs(baseMs + offset);

    const promptText = asString(prop(prop(request, 'message'), 'text'))?.trim();
    if (promptText) {
      const sourceId = `copilot:user:${sid}:${requestId}`;
      messages.push({
        role: 'user',
        text: promptText,
        timestamp: tsAt(0),
        sourceId,
        requestId,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(projectControl ? { projectControl } : {}),
      });
      events.push({
        sequence: eventSequence++,
        type: 'user_text',
        sourceId,
        timestamp: tsAt(0),
        text: promptText,
      });
    }

    const metadata = prop(prop(request, 'result'), 'metadata');
    const results = prop(metadata, 'toolCallResults');
    for (const round of asArray(prop(metadata, 'toolCallRounds')) ?? []) {
      for (const call of asArray(prop(round, 'toolCalls')) ?? []) {
        const callId = asString(prop(call, 'id'));
        if (!callId) continue;
        const toolName = asString(prop(call, 'name'));
        // The validated marker is retained only as machine-local routing metadata.
        // Do not project its absolute paths/claim id into the student's report.
        if (toolName === 'showtail_project_control') continue;
        const rawArguments = asString(prop(call, 'arguments'));
        let input: JsonValue | undefined = rawArguments;
        if (rawArguments) {
          try {
            input = JSON.parse(rawArguments) as JsonValue;
          } catch {
            // Preserve a non-JSON argument string as supplied by the host.
          }
        }
        events.push({
          sequence: eventSequence++,
          type: 'tool_use',
          sourceId: `copilot:tool:${sid}:${callId}:use`,
          timestamp: tsAt(1),
          toolUseId: callId,
          ...(toolName ? { toolName } : {}),
          ...(input === undefined ? {} : { input }),
        });
        const result = prop(results, callId);
        if (result !== undefined) {
          let content: JsonValue | undefined;
          try {
            content = JSON.parse(JSON.stringify(result)) as JsonValue;
          } catch {
            content = undefined;
          }
          events.push({
            sequence: eventSequence++,
            type: 'tool_result',
            sourceId: `copilot:tool:${sid}:${callId}:result`,
            timestamp: tsAt(2),
            toolUseId: callId,
            ...(content === undefined ? {} : { content }),
          });
        }
      }
    }

    // Decisions (vscode_askQuestions) are answered mid-turn, BEFORE Copilot's final
    // reply — so they sort right after the prompt, ahead of the reply below.
    const decisions = decisionsFromRequest(request);
    decisions.forEach((d, k) => {
      messages.push({
        role: 'decision',
        text: d.text,
        timestamp: tsAt(1 + k),
        sourceId: `copilot:decision:${sid}:${d.callId}`,
        requestId,
      });
    });

    const reply = assistantText(request);
    if (reply) {
      const sourceId = `copilot:asst:${sid}:${requestId}`;
      messages.push({
        role: 'assistant',
        text: reply,
        timestamp: tsAt(1 + decisions.length),
        sourceId,
        requestId,
        isFinal,
      });
      events.push({
        sequence: eventSequence++,
        type: 'assistant_text',
        sourceId,
        timestamp: tsAt(1 + decisions.length),
        text: reply,
      });
    }

    // The plan (manage_todo_list) and edits follow the reply.
    const plan = planFromRequest(request);
    if (plan) {
      messages.push({
        role: 'plan',
        text: plan,
        timestamp: tsAt(2 + decisions.length),
        sourceId: `copilot:plan:${sid}:${requestId}`,
        requestId,
      });
      events.push({
        sequence: eventSequence++,
        type: 'plan_snapshot',
        sourceId: `copilot:plan:${sid}:${requestId}:snapshot`,
        timestamp: tsAt(2 + decisions.length),
        plan,
      });
    }

    const edits = editsFromRequest(request, root, options.includeOutsideEdits);
    if (edits.length > 0) {
      const files = edits.map((e) => e.file);
      messages.push({
        role: 'edit',
        text: `Copilot edited ${files.join(', ')}`,
        files,
        edits,
        timestamp: tsAt(3 + decisions.length),
        sourceId: `copilot:edit:${sid}:${requestId}`,
        requestId,
      });
    }
  });

  return {
    sessionId,
    title: sessionId
      ? `Copilot Chat session ${sessionId.slice(0, 8)}`
      : 'Copilot Chat session',
    messages,
    events,
  };
}

/** Reconstruct a chat-session file's content, then parse it. (Signature stable.) */
export function parseCopilotChatTranscript(
  content: string,
  root: string,
  options: CopilotAutomaticCaptureOptions = {},
): CopilotTranscript {
  return parseCopilotSession(reconstructSession(content), root, options);
}

/**
 * The files Copilot edited across a whole session, with ABSOLUTE paths — the input
 * to `--auto` edit-path routing. `@showtail` turns are skipped. Each edit carries a
 * `sourceIdBase` (`copilot:edit:<sid>:<requestId>`); the router appends the chosen
 * display path to form the artifact's stable `sourceId`.
 */
export function extractCopilotEdits(
  session: unknown,
  sessionId: string,
  options: CopilotAutomaticCaptureOptions = {},
): CopilotAbsEdit[] {
  const sid = asString(prop(session, 'sessionId')) ?? sessionId;
  const requests = asArray(prop(session, 'requests')) ?? [];
  const out: CopilotAbsEdit[] = [];
  requests.forEach((request, i) => {
    if (!isObject(request)) return;
    if (!requestInAutomaticCaptureWindow(request, options.automaticCaptureSince)) {
      return;
    }
    const extId = asString(prop(prop(prop(request, 'agent'), 'extensionId'), 'value'));
    if (isOwnAgent(extId)) return;
    const requestId = asString(prop(request, 'requestId')) ?? String(i);
    const timestamp = isoFromMs(asNumber(prop(request, 'timestamp')));
    for (const g of textEditGroups(request)) {
      out.push({
        absPath: g.fsPath,
        diff: g.diff,
        timestamp,
        sourceIdBase: `copilot:edit:${sid}:${requestId}`,
        requestId,
        promptSourceId: `copilot:user:${sid}:${requestId}`,
      });
    }
  });
  return out;
}
