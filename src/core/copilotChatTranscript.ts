/**
 * Parse and discover VS Code **native Copilot Chat** session files.
 *
 * Copilot Chat persists every native session (the normal chat box, not the
 * `@showtail` participant) to disk as a single JSON document at
 * `…/Code/User/workspaceStorage/<hash>/chatSessions/<uuid>.json`. The sibling
 * `…/workspaceStorage/<hash>/workspace.json` maps the opaque `<hash>` to the
 * project folder it was opened for. This is the same on-disk-transcript shape we
 * already read for the Antigravity IDE (Antigravity is a VS Code fork), so we use
 * the same strategy here: discover this project's sessions by folder, then read
 * prompts / replies / edits out of the JSON.
 *
 * This is what makes native Copilot Chat capturable at all. The VS Code extension
 * API does NOT expose native chat to third parties (a real privacy boundary), but
 * the on-disk transcript is plain JSON — so both `showtail import copilot` and the
 * extension's live watcher read these files rather than the (unavailable) live API.
 *
 * Shapes we read (verified against real `version: 3` sessions):
 *   - `sessionId`                         — the chat session id.
 *   - `requests[]`                        — one per turn. Each has:
 *       - `message.text`                  — the user's typed prompt.
 *       - `requestId`                     — a stable per-turn id (for dedupe).
 *       - `timestamp`                     — epoch ms when the turn ran.
 *       - `agent.extensionId.value`       — which chat agent answered (we skip our
 *                                           own `@showtail` participant so the file
 *                                           import never double-counts it).
 *       - `response[]`                    — the assistant's streamed reply. Items
 *                                           with NO `kind` are markdown parts
 *                                           (`{ value }`); `kind:'textEditGroup'`
 *                                           items name files Copilot edited
 *                                           (`uri.fsPath`, `edits`). `kind:'thinking'`
 *                                           is internal reasoning and is dropped.
 *       - `result.metadata.toolCallRounds[].response` — the per-round assistant
 *                                           text; used as a fallback when the
 *                                           `response[]` markdown parts are empty.
 *
 * Mirrors src/core/codexTranscript.ts (discovery + parse + summarize + import),
 * adapted from Codex's JSONL vocabulary to Copilot's single-JSON shape. Everything
 * is local and best-effort: a malformed file or request is skipped, never thrown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEditArtifact, importedArtifactSourceIds } from './artifacts.ts';
import { importedSourceIds } from './events.ts';
import { asArray, asNumber, asString, isObject, prop } from './parse.ts';
import { toRepoRelative, type AuthorPaths } from './storage.ts';
import type { EditedFile } from './hookInput.ts';

/** A normalized message recovered from a Copilot Chat session. */
export interface CopilotMessage {
  /** "user" (typed prompt), "assistant" (text reply), or "edit" (a file changed). */
  role: 'user' | 'assistant' | 'edit';
  text: string;
  /** ISO-8601 timestamp derived from the request's epoch-ms `timestamp`, if present. */
  timestamp?: string;
  /** A stable id so re-imports (and the live watcher) dedupe. */
  sourceId: string;
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
}

/** A chat-session file found on disk. */
export interface CopilotSessionInfo {
  path: string;
  /** The Copilot chat session id (the file's basename, sans `.json`). */
  sessionId: string;
  mtimeMs: number;
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

/** Don't record edits to Showtail/VS Code bookkeeping files. Mirrors hook.ts. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|git|vscode)([\\/]|$)/.test(p);
}

/** Our own chat participant — skip it on file import; the extension logs it live. */
function isOwnAgent(extensionId: string | undefined): boolean {
  return (extensionId ?? '').toLowerCase().includes('showtail');
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
 * lists that storage's `chatSessions/*.json`.
 */
export function findProjectChatSessions(root: string): CopilotSessionInfo[] {
  const want = normPath(root);
  const out: CopilotSessionInfo[] = [];
  for (const base of copilotWorkspaceStorageDirs()) {
    for (const hash of safeReaddir(base)) {
      const storageDir = join(base, hash);
      const folder = workspaceFolder(storageDir);
      if (!folder || normPath(folder) !== want) continue;
      const chatDir = join(storageDir, 'chatSessions');
      for (const entry of safeReaddir(chatDir)) {
        if (!entry.endsWith('.json')) continue;
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
          sessionId: entry.replace(/\.json$/, ''),
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// --- Parsing ---------------------------------------------------------------

/** Read a chat-session file from disk and parse it. */
export function readChatSessionFile(path: string, root: string): CopilotTranscript {
  if (!existsSync(path)) throw new Error(`Copilot chat session not found: ${path}`);
  return parseCopilotChatTranscript(readFileSync(path, 'utf8'), root);
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
 * Assemble the assistant's text reply from a request's `response[]`. The streamed
 * markdown parts have NO `kind` and carry a `value` string; structural parts
 * (`textEditGroup`, `toolInvocationSerialized`, `inlineReference`, …) and internal
 * `thinking` are skipped. Falls back to joining `result.metadata.toolCallRounds[]`
 * `response` strings when no markdown parts are present.
 */
function assistantText(request: unknown): string {
  const parts = asArray(prop(request, 'response')) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (prop(part, 'kind') !== undefined) continue; // structural / thinking / tool
    const value = asString(prop(part, 'value'));
    if (value) chunks.push(value);
  }
  let text = chunks.join('').trim();
  if (text) return text;

  // Fallback: the per-round assistant text recorded in result.metadata.
  const rounds = asArray(
    prop(prop(prop(request, 'result'), 'metadata'), 'toolCallRounds'),
  );
  if (rounds) {
    text = rounds
      .map((r) => asString(prop(r, 'response')) ?? '')
      .join('')
      .trim();
  }
  return text;
}

/**
 * Build best-effort {@link EditedFile}s from a request's `textEditGroup` parts.
 * Each group names a file (`uri.fsPath`) and an `edits` list of `[{ text, range }]`
 * segments. We can't recover the file's prior content from disk-after-the-fact, so
 * the diff is the inserted text rendered as `+ ` lines (pure deletions contribute
 * no body). Files are kept repo-relative, inside the repo, and out of bookkeeping
 * dirs — the same filter Codex applies.
 */
function editsFromRequest(request: unknown, root: string): EditedFile[] {
  const parts = asArray(prop(request, 'response')) ?? [];
  const byFile = new Map<string, string[]>();
  for (const part of parts) {
    if (!isObject(part) || prop(part, 'kind') !== 'textEditGroup') continue;
    const fsPath = asString(prop(prop(part, 'uri'), 'fsPath'));
    if (!fsPath) continue;
    const rel = toRepoRelative(root, fsPath);
    if (rel.startsWith('..') || isInternalPath(rel)) continue;
    // `edits` is an array of edit rounds, each an array of `{ text, range }`.
    const added: string[] = [];
    for (const round of asArray(prop(part, 'edits')) ?? []) {
      for (const seg of asArray(round) ?? []) {
        const text = asString(prop(seg, 'text'));
        if (text) {
          for (const line of text.split('\n')) added.push('+ ' + line);
        }
      }
    }
    const prior = byFile.get(rel) ?? [];
    byFile.set(rel, prior.concat(added));
  }
  const out: EditedFile[] = [];
  for (const [file, lines] of byFile) {
    out.push({ file, diff: lines.join('\n') });
  }
  return out;
}

/**
 * Parse a Copilot chat-session JSON into normalized messages. For each request we
 * emit the user's prompt, the assistant's text reply, and any file edits — each
 * tagged with a stable `sourceId` keyed off the session + `requestId` so the live
 * watcher and a later `import` never double-count. Requests answered by our own
 * `@showtail` participant are skipped (the extension logs those live). Malformed
 * input is skipped, never thrown.
 */
export function parseCopilotChatTranscript(
  content: string,
  root: string,
): CopilotTranscript {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return { sessionId: undefined, title: 'Copilot Chat session', messages: [] };
  }

  const sessionId = asString(prop(doc, 'sessionId'));
  const requests = asArray(prop(doc, 'requests')) ?? [];
  const messages: CopilotMessage[] = [];
  const sid = sessionId ?? '?';

  requests.forEach((request, i) => {
    if (!isObject(request)) return;
    // `agent.extensionId` is `{ value, _lower }`; key off its `value`.
    const extId = asString(prop(prop(prop(request, 'agent'), 'extensionId'), 'value'));
    if (isOwnAgent(extId)) return;

    const requestId = asString(prop(request, 'requestId')) ?? String(i);
    const timestamp = isoFromMs(asNumber(prop(request, 'timestamp')));

    const promptText = asString(prop(prop(request, 'message'), 'text'))?.trim();
    if (promptText) {
      messages.push({
        role: 'user',
        text: promptText,
        timestamp,
        sourceId: `copilot:user:${sid}:${requestId}`,
      });
    }

    const reply = assistantText(request);
    if (reply) {
      messages.push({
        role: 'assistant',
        text: reply,
        timestamp,
        sourceId: `copilot:asst:${sid}:${requestId}`,
      });
    }

    const edits = editsFromRequest(request, root);
    if (edits.length > 0) {
      const files = edits.map((e) => e.file);
      messages.push({
        role: 'edit',
        text: `Copilot edited ${files.join(', ')}`,
        files,
        edits,
        timestamp,
        sourceId: `copilot:edit:${sid}:${requestId}`,
      });
    }
  });

  return {
    sessionId,
    title: sessionId
      ? `Copilot Chat session ${sessionId.slice(0, 8)}`
      : 'Copilot Chat session',
    messages,
  };
}

// --- Summaries (for the import picker) -------------------------------------

/**
 * Summarize every Copilot session for `author.shared.root`, newest first, so the
 * picker can show counts, a span, and first/last prompt. Each session is parsed
 * once; a session that fails to parse still appears (counts zeroed) so `--file` can
 * reach it. `importState` is computed against the trail's existing source ids.
 */
export function summarizeChatSessions(author: AuthorPaths): CopilotSessionSummary[] {
  const seen = importedSourceIds(author);
  const seenArtifacts = importedArtifactSourceIds(author);
  const root = author.shared.root;
  const isImported = (m: CopilotMessage): boolean => {
    if (m.role === 'edit') {
      const files = m.files ?? [];
      return (
        files.length > 0 && files.every((f) => seenArtifacts.has(`${m.sourceId}#${f}`))
      );
    }
    return seen.has(m.sourceId);
  };
  return findProjectChatSessions(root).map((info) => {
    const summary: CopilotSessionSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: CopilotTranscript;
    try {
      parsed = parseCopilotChatTranscript(readFileSync(info.path, 'utf8'), root);
    } catch {
      return summary;
    }

    const prompts = parsed.messages.filter((m) => m.role === 'user');
    summary.promptCount = prompts.length;
    summary.editCount = parsed.messages.filter((m) => m.role === 'edit').length;
    summary.firstPrompt = prompts[0]?.text ?? '';
    summary.lastPrompt = prompts[prompts.length - 1]?.text ?? '';

    let importedCount = 0;
    for (const m of parsed.messages) {
      if (isImported(m)) importedCount += 1;
      if (m.timestamp) {
        if (!summary.first || m.timestamp < summary.first) summary.first = m.timestamp;
        if (!summary.last || m.timestamp > summary.last) summary.last = m.timestamp;
      }
    }
    if (parsed.messages.length > 0) {
      summary.importState =
        importedCount === 0
          ? 'none'
          : importedCount === parsed.messages.length
            ? 'full'
            : 'partial';
    }

    return summary;
  });
}

// --- Importing -------------------------------------------------------------

export interface CopilotImportOptions {
  /** Also log Copilot's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface CopilotImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed Copilot session into the trail. User prompts become `prompt`
 * events, assistant replies become `ai_output` (only with `withResponses`), and
 * each edit becomes a back-dated `artifact` carrying its captured (added-line) diff
 * — just like the Codex importer. Every event is tagged `tool: github-copilot` and
 * `imported`, stamped with the original time, and deduped by `sourceId` so
 * re-importing (or the live watcher re-reading the file) adds nothing.
 */
export async function importCopilotChatTranscript(
  author: AuthorPaths,
  transcript: CopilotTranscript,
  options: CopilotImportOptions = {},
): Promise<CopilotImportResult> {
  const { logEvent } = await import('./events.ts');
  const seen = importedSourceIds(author);
  const seenArtifacts = importedArtifactSourceIds(author);
  const result: CopilotImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    skipped: 0,
  };

  const stampSpan = (ts: string | undefined): void => {
    if (!ts) return;
    if (!result.first || ts < result.first) result.first = ts;
    if (!result.last || ts > result.last) result.last = ts;
  };

  // A user prompt opens a turn; the reply/edits that follow link back via this id.
  let currentTurnId: string | undefined;

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && !options.withResponses) continue;

    if (msg.role === 'edit') {
      for (const e of msg.edits ?? []) {
        const sourceId = `${msg.sourceId}#${e.file}`;
        if (seenArtifacts.has(sourceId)) {
          result.skipped += 1;
          continue;
        }
        const wrote = importEditArtifact(author, {
          path: e.file,
          diff: e.diff ?? '',
          tool: 'github-copilot',
          turnId: currentTurnId,
          timestamp: msg.timestamp,
          sessionId: options.sessionId,
          sourceId,
          batchId: options.batchId,
        });
        if (wrote) {
          seenArtifacts.add(sourceId);
          result.edits += 1;
          stampSpan(msg.timestamp);
        }
      }
      continue;
    }

    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const { event } = await logEvent(author, {
      type: msg.role === 'user' ? 'prompt' : 'ai_output',
      text: msg.text,
      tool: 'github-copilot',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      tags: ['imported'],
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') {
      currentTurnId = event.id;
      result.prompts += 1;
    } else {
      result.responses += 1;
    }

    stampSpan(msg.timestamp);
  }

  return result;
}
