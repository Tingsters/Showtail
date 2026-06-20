/**
 * Import an existing Claude Code session transcript from disk.
 *
 * Claude Code writes a full JSONL transcript of every session to
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (one object per line).
 * A student who only enabled Showtail partway through — or not at all — can use
 * this to back-fill their trail from that transcript, so it reads as if Showtail
 * had been capturing from the start.
 *
 * Everything here is local: no network, and the roles are explicit in the
 * transcript, so (unlike the ChatGPT paste importer) there is no guessing about
 * what the student wrote vs. what the AI produced.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importedSourceIds, logEvent } from './events.ts';
import { asArray, asString, isObject, prop } from './parse.ts';
import { toRepoRelative, type ShowtailPaths } from './storage.ts';

/** A normalized message recovered from a transcript. */
export interface ClaudeMessage {
  /** "user" (a typed prompt), "assistant" (a text reply), or "edit" (a file the AI changed). */
  role: 'user' | 'assistant' | 'edit';
  text: string;
  /** ISO-8601 timestamp from the transcript line, if present. */
  timestamp?: string;
  /** A stable id (the line uuid, or a tool_use id) so re-imports dedupe. */
  sourceId: string;
  /** For edits: the repo-relative file path(s) the AI touched. */
  files?: string[];
}

/** A normalized transcript: just the messages we care about, in order. */
export interface ClaudeTranscript {
  sessionId?: string;
  title: string;
  messages: ClaudeMessage[];
}

/** A transcript file found on disk for a given project. */
export interface TranscriptInfo {
  path: string;
  /** The Claude Code session id (the file name without `.jsonl`). */
  sessionId: string;
  mtimeMs: number;
}

/**
 * An at-a-glance summary of one transcript, so a student can tell sessions
 * apart in the picker without opening each file. Built by parsing the
 * transcript once and counting what's in it.
 */
export interface TranscriptSummary {
  info: TranscriptInfo;
  /** Number of typed prompts in the session. */
  promptCount: number;
  /** Number of file edits Claude made in the session. */
  editCount: number;
  /** The first and last typed prompt (for recognizing the session). */
  firstPrompt: string;
  lastPrompt: string;
  /** Earliest / latest message timestamp (ISO), for a rough duration. */
  first?: string;
  last?: string;
  /**
   * Whether this session is already in the trail: `none` (nothing imported),
   * `full` (every message already imported), or `partial` (some but not all).
   */
  importState: 'none' | 'partial' | 'full';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** User-content wrappers that are tooling chrome, not something the student typed. */
const WRAPPER_RE =
  /^<(local-command-caveat|command-name|command-message|command-args|command-stdout|command-stderr|user-prompt-submit-hook|session-start-hook)/;

/** Don't record edits to Showtail/Claude bookkeeping files. Mirrors hook.ts. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|claude)([\\/]|$)/.test(p);
}

// --- Locating transcripts on disk -----------------------------------------

function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? override : join(homedir(), '.claude');
}

/** The directory Claude Code stores per-project session transcripts under. */
export function claudeProjectsDir(): string {
  return join(claudeHome(), 'projects');
}

/**
 * Compare two absolute paths for equality. Both the project root and the
 * transcript `cwd` are already absolute, so we normalize separators and (on
 * Windows) case rather than going through `path.resolve` — which can't be
 * trusted to keep win32 semantics across runtimes.
 */
function normPath(p: string): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Read the first chunk of a (possibly huge) file without slurping all of it. */
function readHead(path: string, maxBytes = 131072): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/** Pull the `cwd` field out of the first transcript line that carries one. */
function cwdOf(head: string): string | null {
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // A line cut off by the head window (or malformed) — keep scanning.
    }
  }
  return null;
}

/**
 * Find every Claude Code transcript that belongs to `root`, newest first.
 *
 * We match by the `cwd` field *embedded in each transcript* rather than trusting
 * the encoded directory name (Claude Code rewrites `/ \ : .` to `-`, and that
 * encoding has shifted across versions). Reading the embedded cwd is exact.
 */
export function findProjectTranscripts(root: string): TranscriptInfo[] {
  const dir = claudeProjectsDir();
  if (!existsSync(dir)) return [];
  const out: TranscriptInfo[] = [];

  for (const projectDir of safeReaddir(dir)) {
    const full = join(dir, projectDir);
    if (!isDir(full)) continue;
    for (const file of safeReaddir(full)) {
      if (!file.endsWith('.jsonl')) continue;
      const fp = join(full, file);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      let cwd: string | null = null;
      try {
        cwd = cwdOf(readHead(fp));
      } catch {
        continue;
      }
      if (!cwd || !samePath(cwd, root)) continue;

      out.push({
        path: fp,
        sessionId: file.replace(/\.jsonl$/, ''),
        mtimeMs: st.mtimeMs,
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Summarize every transcript for `paths.root`, newest first, so the picker can
 * show counts, a time span, and first/last prompt for each. Each transcript is
 * parsed once; a transcript that fails to parse still appears (counts zeroed)
 * so it can be tried via `--file`. `importState` is computed against the source
 * ids already in the trail so the picker can flag already-imported sessions.
 */
export function summarizeTranscripts(paths: ShowtailPaths): TranscriptSummary[] {
  const seen = importedSourceIds(paths);
  return findProjectTranscripts(paths.root).map((info) => {
    const summary: TranscriptSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: ClaudeTranscript;
    try {
      parsed = parseClaudeTranscript(readFileSync(info.path, 'utf8'), paths.root);
    } catch {
      return summary; // Couldn't parse — list it bare so --file can still reach it.
    }

    const prompts = parsed.messages.filter((m) => m.role === 'user');
    summary.promptCount = prompts.length;
    summary.editCount = parsed.messages.filter((m) => m.role === 'edit').length;
    summary.firstPrompt = prompts[0]?.text ?? '';
    summary.lastPrompt = prompts[prompts.length - 1]?.text ?? '';

    let importedCount = 0;
    for (const m of parsed.messages) {
      if (seen.has(m.sourceId)) importedCount += 1;
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

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- Parsing ---------------------------------------------------------------

/** Read a transcript file from disk and parse it. */
export function readTranscriptFile(path: string, root: string): ClaudeTranscript {
  if (!existsSync(path)) {
    throw new Error(`Transcript not found: ${path}`);
  }
  return parseClaudeTranscript(readFileSync(path, 'utf8'), root);
}

/**
 * Parse a Claude Code JSONL transcript into normalized messages. Edits are
 * reported relative to `root` (and edits outside the repo, or to internal
 * `.showtail`/`.claude` files, are dropped). Malformed lines are skipped.
 */
export function parseClaudeTranscript(content: string, root: string): ClaudeTranscript {
  const messages: ClaudeMessage[] = [];
  let sessionId: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const sid = asString(prop(obj, 'sessionId'));
    if (sid !== undefined && !sessionId) sessionId = sid;

    // Drop noise that isn't the student's direct work.
    if (
      prop(obj, 'isSidechain') === true ||
      prop(obj, 'isMeta') === true ||
      prop(obj, 'isApiErrorMessage') === true
    ) {
      continue;
    }

    const type = prop(obj, 'type');
    if (type === 'user') {
      const msg = handleUser(obj);
      if (msg) messages.push(msg);
    } else if (type === 'assistant') {
      messages.push(...handleAssistant(obj, root));
    }
  }

  return {
    sessionId,
    title: sessionId
      ? `Claude Code session ${sessionId.slice(0, 8)}`
      : 'Claude Code session',
    messages,
  };
}

/** A real typed prompt: string content, not a tool result or a tooling wrapper. */
function handleUser(obj: unknown): ClaudeMessage | null {
  const content = asString(prop(prop(obj, 'message'), 'content'));
  if (content === undefined) return null; // tool_result lines carry an array.

  const source = prop(obj, 'promptSource');
  // Accept typed/pasted prompts; older transcripts may omit the field entirely.
  if (typeof source === 'string' && source !== 'typed' && source !== 'paste') return null;

  const text = content.trim();
  if (!text || WRAPPER_RE.test(text)) return null;

  return {
    role: 'user',
    text,
    timestamp: asString(prop(obj, 'timestamp')),
    sourceId: asString(prop(obj, 'uuid')) ?? `cc:user:${text.slice(0, 24)}`,
  };
}

/** Assistant turns: text parts become one reply; Edit/Write/MultiEdit become edits. */
function handleAssistant(obj: unknown, root: string): ClaudeMessage[] {
  const msg = prop(obj, 'message');
  if (!msg || prop(msg, 'model') === '<synthetic>') return [];
  const content = asArray(prop(msg, 'content'));
  if (!content) return [];

  const timestamp = asString(prop(obj, 'timestamp'));
  const uuid = asString(prop(obj, 'uuid')) ?? '';
  const out: ClaudeMessage[] = [];

  const texts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;

    const type = prop(part, 'type');
    const partText = asString(prop(part, 'text'));
    const name = prop(part, 'name');
    if (type === 'text' && partText !== undefined && partText.trim()) {
      texts.push(partText.trim());
    } else if (type === 'tool_use' && typeof name === 'string' && EDIT_TOOLS.has(name)) {
      const rel = relForEdit(prop(prop(part, 'input'), 'file_path'), root);
      if (!rel) continue;
      const partId = asString(prop(part, 'id'));
      out.push({
        role: 'edit',
        text: `Claude edited ${rel}`,
        files: [rel],
        timestamp,
        sourceId: partId ? partId : `${uuid}:${out.length}`,
      });
    }
  }

  if (texts.length > 0) {
    out.unshift({
      role: 'assistant',
      text: texts.join('\n'),
      timestamp,
      sourceId: uuid || `cc:asst:${texts[0]!.slice(0, 24)}`,
    });
  }

  return out;
}

/** Repo-relative path for an edited file, or null if outside the repo / internal. */
function relForEdit(filePath: unknown, root: string): string | null {
  if (typeof filePath !== 'string' || !filePath) return null;
  const rel = toRepoRelative(root, filePath);
  if (rel.startsWith('..') || isInternalPath(rel)) return null;
  return rel;
}

// --- Importing -------------------------------------------------------------

export interface ClaudeImportOptions {
  /** Also log Claude's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface ClaudeImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed transcript into the trail. User prompts become `prompt`
 * events, assistant replies become `ai_output` (only with `withResponses`),
 * and each AI edit becomes a back-dated `artifact` event noting the file —
 * not a hash snapshot, since a past file's hash can't be recovered. Every
 * event is tagged `tool: claude-code` and `imported`, stamped with the original
 * time, and deduped by `sourceId` so re-importing the same transcript adds nothing.
 */
export async function importClaudeTranscript(
  paths: ShowtailPaths,
  transcript: ClaudeTranscript,
  options: ClaudeImportOptions = {},
): Promise<ClaudeImportResult> {
  const seen = importedSourceIds(paths);
  const result: ClaudeImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    skipped: 0,
  };

  // A user prompt opens a turn; the assistant reply and edits that follow it
  // link back via this id, so the report groups the imported exchange.
  let currentTurnId: string | undefined;

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && !options.withResponses) continue;
    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const type =
      msg.role === 'user'
        ? 'prompt'
        : msg.role === 'assistant'
          ? 'ai_output'
          : 'artifact';

    const { event } = await logEvent(paths, {
      type,
      text: msg.text,
      tool: 'claude-code',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      files: msg.files,
      tags: ['imported'],
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') currentTurnId = event.id;

    if (msg.role === 'user') result.prompts += 1;
    else if (msg.role === 'assistant') result.responses += 1;
    else result.edits += 1;

    if (msg.timestamp) {
      if (!result.first || msg.timestamp < result.first) result.first = msg.timestamp;
      if (!result.last || msg.timestamp > result.last) result.last = msg.timestamp;
    }
  }

  return result;
}
