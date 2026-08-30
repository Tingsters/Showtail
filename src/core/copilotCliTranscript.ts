/**
 * Parse and discover GitHub Copilot CLI session "Chronicle" event logs.
 *
 * The Copilot CLI (github-copilot-sdk) persists each session under
 * `~/.copilot/session-state/<sessionId>/`. The readable transcript is
 * `events.jsonl` — one JSON object per line, each `{ type, data, id, timestamp,
 * parentId }` (a "Chronicle" of typed events). A parallel `session.db` SQLite
 * index holds bookkeeping (todos, inbox) but no conversation text, so we read
 * the JSONL.
 *
 * This mirrors src/core/codexTranscript.ts (the closest pattern: a CLI that
 * writes JSONL sessions on disk, located by session id or newest mtime), adapted
 * to Copilot CLI's event vocabulary. We read only the shapes we care about so
 * Showtail can reconcile AI replies at stop time:
 *
 *   - `session.start`     — `data.sessionId` (session id) and
 *                           `data.context.cwd` / `data.context.gitRoot` (root).
 *   - `user.message`      — the student's typed prompt (`data.content`). The
 *                           parallel `data.transformedContent` wraps the prompt
 *                           with `<system_reminder>` / datetime chrome, so we key
 *                           prompts off the clean `content`.
 *   - `assistant.message` — the model's text reply (`data.content`). A turn that
 *                           only calls tools has empty `content`; we drop those.
 *                           `data.toolRequests` carry edit/other tool calls.
 *   - `tool.execution_start` — a tool invocation. File-editing tools (whose
 *                           arguments name a path) become `edit` messages so the
 *                           shape matches Codex, though the generic stop reconcile
 *                           drops `edit` (the PostToolUse hook already records
 *                           edits).
 *
 * PLANS / DECISIONS: Copilot CLI records NO plan or decision construct in
 * events.jsonl. Its plan/todo tool persists to the per-session SQLite
 * (`todos` / `todo_deps` tables), not to the event stream, and there is no
 * "exit plan mode" / decision event. So — unlike Claude Code — this parser emits
 * only `user` / `assistant` (+ `edit`) messages; we do NOT fabricate plans or
 * decisions. If a future Copilot CLI surfaces a plan event here, add a branch.
 *
 * Everything is local and best-effort: malformed lines are skipped, never thrown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hostHome } from './hostHome.ts';
import { asString, prop } from './parse.ts';
import type {
  HookTranscript,
  HookTranscriptEvent,
  HookTranscriptMessage,
} from '../plugins/types.ts';
import type { JsonValue } from '../types.ts';

/** A normalized message recovered from a Copilot CLI event log. */
export interface CopilotCliMessage {
  /** "user" (typed prompt), "assistant" (text reply), or "edit" (a file changed). */
  role: 'user' | 'assistant' | 'edit';
  text: string;
  /** ISO-8601 timestamp from the event line, if present. */
  timestamp?: string;
  /** A stable id so re-imports dedupe. */
  sourceId: string;
  /** For edits: the repo-relative file path(s) Copilot touched. */
  files?: string[];
  /** For an assistant reply: the model id (`data.model`, e.g. `gpt-5.3-codex`). */
  model?: string;
}

/** A normalized session: the messages we care about, in order. */
export interface CopilotCliTranscript {
  sessionId?: string;
  title: string;
  messages: CopilotCliMessage[];
  events: HookTranscriptEvent[];
}

/** A Copilot CLI session event log found on disk. */
export interface CopilotCliSessionInfo {
  /** Absolute path to the session's `events.jsonl`. */
  path: string;
  /** The session id (the session-state directory name). */
  sessionId: string;
  mtimeMs: number;
}

/** Don't record edits to Showtail/Copilot bookkeeping files. Mirrors hook.ts. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|copilot)([\\/]|$)/.test(p);
}

// --- Locating sessions on disk ---------------------------------------------

/**
 * The directory Copilot CLI stores per-session event logs under
 * (`~/.copilot/session-state`). Honors a `COPILOT_HOME` override (mirroring
 * Codex's `CODEX_HOME`) for tests and non-default installs, else `~/.copilot`.
 */
export function copilotCliSessionsDir(): string {
  return join(hostHome('COPILOT_HOME', '.copilot'), 'session-state');
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

/**
 * Find every Copilot CLI session event log under `~/.copilot/session-state`,
 * newest first. Each session is a `<sessionId>/events.jsonl`; a session dir
 * without an `events.jsonl` (one that never started a conversation) is skipped.
 * Unreadable entries are tolerated.
 */
export function findCopilotCliSessions(): CopilotCliSessionInfo[] {
  const root = copilotCliSessionsDir();
  if (!existsSync(root)) return [];
  const out: CopilotCliSessionInfo[] = [];

  for (const entry of safeReaddir(root)) {
    const dir = join(root, entry);
    if (!isDir(dir)) continue;
    const file = join(dir, 'events.jsonl');
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      continue; // No events.jsonl in this session dir.
    }
    if (!st.isFile()) continue;
    out.push({ path: file, sessionId: entry, mtimeMs: st.mtimeMs });
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Locate the session this Stop belongs to: prefer the one whose id matches
 * `sessionId`; otherwise the most recently modified (the one that just stopped).
 * Returns null when nothing plausible is on disk.
 */
export function findCopilotCliSession(sessionId?: string): CopilotCliSessionInfo | null {
  const sessions = findCopilotCliSessions();
  if (sessions.length === 0) return null;
  if (sessionId) {
    const byId = sessions.find((s) => s.sessionId === sessionId);
    if (byId) return byId;
  }
  return sessions[0]!; // newest first
}

// --- Parsing ---------------------------------------------------------------

/** Read a session event log from disk and parse it. */
export function readCopilotCliSessionFile(
  path: string,
  root: string,
): CopilotCliTranscript {
  if (!existsSync(path)) throw new Error(`Copilot CLI session not found: ${path}`);
  return parseCopilotCliSession(readFileSync(path, 'utf8'), root);
}

/** Normalize a possibly-absolute path to a repo-relative, posix-separated path. */
function toRel(rawPath: string, root: string): string {
  // Already-relative paths keep their value; absolute ones are made relative to
  // the repo root so the downstream in-repo guard can match them.
  const rel = /^([a-zA-Z]:[\\/]|[\\/])/.test(rawPath) ? relative(root, rawPath) : rawPath;
  return rel.replace(/\\/g, '/');
}

/**
 * The set of `arguments` keys a Copilot CLI file-editing tool uses to name its
 * target file. We treat any tool call carrying one of these as an edit. (We key
 * off the argument shape rather than a tool-name allow-list because the CLI's
 * edit tool name isn't stable across versions and isn't documented here.)
 */
const EDIT_PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file'];

/** Pull the edited file path out of a tool call's arguments, if it is an edit. */
function editedFile(args: unknown): string | undefined {
  for (const key of EDIT_PATH_KEYS) {
    const v = asString(prop(args, key));
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Parse a Copilot CLI `events.jsonl` into normalized messages. Prompts come from
 * `user.message`, replies from `assistant.message` (non-empty `content`), and
 * edits from file-editing `tool.execution_start` calls. Edits are reported
 * relative to `root`; edits outside the repo, or to internal
 * `.showtail`/`.copilot` files, are dropped. Malformed lines are skipped.
 */
export function parseCopilotCliSession(
  content: string,
  root: string,
): CopilotCliTranscript {
  const messages: CopilotCliMessage[] = [];
  const events: HookTranscriptEvent[] = [];
  let eventSequence = 0;
  let sessionId: string | undefined;
  // Stable, monotonic counters so messages without a natural id still dedupe
  // deterministically across re-reads of the same (append-only) log.
  let userSeq = 0;
  let asstSeq = 0;
  let toolSeq = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = asString(prop(obj, 'type'));
    const data = prop(obj, 'data');
    const timestamp = asString(prop(obj, 'timestamp'));

    if (type === 'session.start') {
      const id = asString(prop(data, 'sessionId'));
      if (id && !sessionId) sessionId = id;
      continue;
    }

    if (type === 'user.message') {
      const text = asString(prop(data, 'content'))?.trim();
      if (!text) continue;
      const sourceId = `copilot:user:${sessionId ?? '?'}:${userSeq++}`;
      messages.push({
        role: 'user',
        text,
        timestamp,
        sourceId,
      });
      events.push({
        sequence: eventSequence++,
        type: 'user_text',
        sourceId,
        timestamp,
        text,
      });
    } else if (type === 'assistant.message') {
      const text = asString(prop(data, 'content'))?.trim();
      // A tool-only turn has empty content; nothing to capture as a reply.
      if (!text) continue;
      // Prefer the model's own messageId for a stable id; else a sequence.
      const messageId = asString(prop(data, 'messageId'));
      const sourceId = messageId
        ? `copilot:asst:${messageId}`
        : `copilot:asst:${sessionId ?? '?'}:${asstSeq++}`;
      messages.push({
        role: 'assistant',
        text,
        timestamp,
        sourceId,
        model: asString(prop(data, 'model')),
      });
      events.push({
        sequence: eventSequence++,
        type: 'assistant_text',
        sourceId,
        timestamp,
        text,
      });
    } else if (type === 'tool.execution_start') {
      const callId = asString(prop(data, 'toolCallId')) ?? `copilot:tool:${toolSeq++}`;
      const toolName = asString(prop(data, 'toolName')) ?? asString(prop(data, 'name'));
      const rawArguments = prop(data, 'arguments');
      let input: JsonValue | undefined;
      try {
        input =
          typeof rawArguments === 'string'
            ? (JSON.parse(rawArguments) as JsonValue)
            : (JSON.parse(JSON.stringify(rawArguments)) as JsonValue);
      } catch {
        input = typeof rawArguments === 'string' ? rawArguments : undefined;
      }
      events.push({
        sequence: eventSequence++,
        type: 'tool_use',
        sourceId: `${callId}:use`,
        timestamp,
        toolUseId: callId,
        ...(toolName ? { toolName } : {}),
        ...(input === undefined ? {} : { input }),
      });
      const file = editedFile(prop(data, 'arguments'));
      if (!file) continue; // Not a file edit (e.g. rename_session, shell).
      const rel = toRel(file, root);
      if (rel.startsWith('..') || isInternalPath(rel)) continue;
      messages.push({
        role: 'edit',
        text: `Copilot edited ${rel}`,
        files: [rel],
        timestamp,
        sourceId: `copilot:edit:${callId}`,
      });
    } else if (
      type === 'tool.execution_complete' ||
      type === 'tool.execution_end' ||
      type === 'tool.execution_error'
    ) {
      const callId = asString(prop(data, 'toolCallId')) ?? asString(prop(data, 'id'));
      if (!callId) continue;
      const rawResult = prop(data, 'result') ?? prop(data, 'output');
      let result: JsonValue | undefined;
      try {
        result = JSON.parse(JSON.stringify(rawResult)) as JsonValue;
      } catch {
        result = undefined;
      }
      const stdout = asString(prop(data, 'stdout'));
      const stderr = asString(prop(data, 'stderr'));
      const exitCode =
        typeof prop(data, 'exitCode') === 'number'
          ? (prop(data, 'exitCode') as number)
          : typeof prop(data, 'exit_code') === 'number'
            ? (prop(data, 'exit_code') as number)
            : undefined;
      events.push({
        sequence: eventSequence++,
        type: 'tool_result',
        sourceId: `${callId}:result`,
        timestamp,
        toolUseId: callId,
        ...(result === undefined ? {} : { content: result }),
        ...(type === 'tool.execution_error' ? { isError: true } : {}),
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    }
  }

  return {
    sessionId,
    title: sessionId
      ? `Copilot CLI session ${sessionId.slice(0, 8)}`
      : 'Copilot CLI session',
    messages,
    events,
  };
}

/**
 * Parse an `events.jsonl` into the tool-agnostic {@link HookTranscript} the
 * generic stop reconcile in commands/hook.ts consumes. `edit` messages are
 * dropped — the post-edit hook already records those — leaving prompts and
 * assistant replies. (No plan/decision messages are emitted; see the file
 * header for why Copilot CLI records none.)
 */
export function parseCopilotCliTranscript(content: string, root: string): HookTranscript {
  const parsed = parseCopilotCliSession(content, root);
  const messages: HookTranscriptMessage[] = [];
  for (const m of parsed.messages) {
    if (m.role === 'edit') continue;
    messages.push({
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      sourceId: m.sourceId,
      model: m.model,
    });
  }
  return { sessionId: parsed.sessionId, messages, events: parsed.events };
}
