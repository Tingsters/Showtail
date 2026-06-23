/**
 * Parse and discover OpenAI Codex "rollout" session files.
 *
 * Codex persists a full JSONL transcript of every session — its *rollout* — at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl` (one JSON object per
 * line). Each line is `{ timestamp, type, payload }`. We read the shapes we care
 * about so Showtail can (a) reconcile AI replies at stop time and (b) back-fill
 * a trail from an existing session via `showtail import codex`.
 *
 * Mirrors src/core/claudeCode.ts (the canonical transcript parser + discovery +
 * import surface), adapted to Codex's JSONL vocabulary:
 *
 *   - `session_meta`            — `payload.id` (session id) and `payload.cwd`.
 *   - `event_msg`/`user_message`  — the student's typed prompt (`payload.message`).
 *     This is the clean, de-noised form; the parallel `response_item`/`message`
 *     role=user line also carries the prompt but is wrapped with AGENTS.md and
 *     developer chrome, so we key prompts off `user_message`.
 *   - `event_msg`/`agent_message` — the assistant's text reply (`payload.message`),
 *     phase `final_answer`. The parallel `response_item`/`message` role=assistant
 *     duplicates it; we key replies off `agent_message`.
 *   - `response_item`/`custom_tool_call` name=`apply_patch` — an edit. `payload.input`
 *     is the apply-patch envelope; `payload.call_id` is a stable id.
 *   - `response_item`/`function_call` name=`update_plan` — Codex's plan/todo list.
 *     `payload.arguments` is a JSON string `{ explanation?, plan: [{step,status}] }`;
 *     `payload.call_id` is a stable id. Codex runs headless and never asks the
 *     student to approve its plan (the parallel `function_call_output` is just
 *     "Plan updated"), so a Codex plan carries no approval — and Codex has no
 *     ask-the-user/decision construct at all (the only tools are apply_patch,
 *     shell_command and update_plan), so we never emit a `decision` message.
 *
 * Everything is local and best-effort: malformed lines are skipped, never thrown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importedSourceIds } from './events.ts';
import { asArray, asString, isObject, prop } from './parse.ts';
import { PLAN_APPROVED_TAG } from './plans.ts';
import { toRepoRelative, type AuthorPaths } from './storage.ts';
import type { HookTranscript, HookTranscriptMessage } from '../plugins/types.ts';

/** A normalized message recovered from a Codex rollout. */
export interface CodexMessage {
  /**
   * "user" (typed prompt), "assistant" (text reply), "edit" (a file changed), or
   * "plan" (a todo/plan list Codex built via its `update_plan` tool).
   */
  role: 'user' | 'assistant' | 'edit' | 'plan';
  text: string;
  /** ISO-8601 timestamp from the rollout line, if present. */
  timestamp?: string;
  /** A stable id so re-imports dedupe. */
  sourceId: string;
  /** For edits: the repo-relative file path(s) Codex touched. */
  files?: string[];
}

/** A normalized rollout: the messages we care about, in order. */
export interface CodexTranscript {
  sessionId?: string;
  title: string;
  messages: CodexMessage[];
}

/** A rollout file found on disk. */
export interface CodexRolloutInfo {
  path: string;
  /** The Codex session id (from the session_meta line, or parsed from the name). */
  sessionId: string;
  mtimeMs: number;
}

/** An at-a-glance summary of one rollout, for the import picker / `--list`. */
export interface CodexRolloutSummary {
  info: CodexRolloutInfo;
  promptCount: number;
  editCount: number;
  firstPrompt: string;
  lastPrompt: string;
  first?: string;
  last?: string;
  importState: 'none' | 'partial' | 'full';
}

// File headers in an apply_patch envelope (Add/Update/Move keep the file; Delete
// drops it). Mirrors APPLY_PATCH_FILE_RE in hookInput.ts.
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Move) File: (.+)$/gm;

/** Don't record edits to Showtail/Codex bookkeeping files. Mirrors hook.ts. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|codex)([\\/]|$)/.test(p);
}

// --- Locating rollouts on disk --------------------------------------------

/** The directory Codex stores per-session rollout files under (`~/.codex/sessions`). */
export function codexSessionsDir(): string {
  const override = process.env.CODEX_HOME;
  const base = override && override.length > 0 ? override : join(homedir(), '.codex');
  return join(base, 'sessions');
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

/** Pull the session id out of a `rollout-<ISO>-<uuid>.jsonl` file name. */
function sessionIdFromName(file: string): string {
  // rollout-2026-06-22T16-57-00-019ef1c4-1899-7a90-bb9f-b09bca10e91c.jsonl
  const m =
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return m ? m[1]! : file.replace(/\.jsonl$/, '');
}

/**
 * Find every Codex rollout file under `~/.codex/sessions`, newest first. Codex
 * nests them under `YYYY/MM/DD/`, so we walk the date tree (best-effort: any
 * unreadable directory is skipped). Unlike Claude Code, Codex rollouts are not
 * partitioned by project, so callers that want a single project's sessions
 * filter by the rollout's recorded `cwd` (see {@link findProjectRollouts}).
 */
export function findRollouts(): CodexRolloutInfo[] {
  const root = codexSessionsDir();
  if (!existsSync(root)) return [];
  const out: CodexRolloutInfo[] = [];

  // Walk YYYY/MM/DD; tolerate a flat layout too (files directly under a dir).
  const walk = (dir: string, depth: number): void => {
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry);
      if (isDir(full)) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({ path: full, sessionId: sessionIdFromName(entry), mtimeMs: st.mtimeMs });
    }
  };
  walk(root, 0);

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Read the recorded `cwd` from a rollout's `session_meta` line, if present. */
function rolloutCwd(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (prop(obj, 'type') !== 'session_meta') continue;
    const cwd = asString(prop(prop(obj, 'payload'), 'cwd'));
    return cwd ?? null;
    // session_meta is the first line, so we never scan the whole file.
  }
  return null;
}

/** Normalize two absolute paths for comparison (separators + win32 case). */
function normPath(p: string): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * Find the rollouts whose recorded `cwd` is `root`, newest first. Reads only the
 * head of each file (the `session_meta` line is first) to keep this cheap.
 */
export function findProjectRollouts(root: string): CodexRolloutInfo[] {
  return findRollouts().filter((info) => {
    let cwd: string | null = null;
    try {
      cwd = rolloutCwd(readFileSync(info.path, 'utf8'));
    } catch {
      return false;
    }
    return cwd !== null && normPath(cwd) === normPath(root);
  });
}

// --- Parsing ---------------------------------------------------------------

/** Read a rollout file from disk and parse it. */
export function readRolloutFile(path: string, root: string): CodexTranscript {
  if (!existsSync(path)) throw new Error(`Codex rollout not found: ${path}`);
  return parseCodexTranscript(readFileSync(path, 'utf8'), root);
}

/**
 * Parse a Codex rollout JSONL into normalized messages. Edits are reported
 * relative to `root` (edits outside the repo, or to internal `.showtail`/`.codex`
 * files, are dropped). Malformed lines are skipped. Prompts come from
 * `user_message`, replies from `agent_message`, and edits from `apply_patch`
 * `custom_tool_call`s — the de-noised forms, so the wrapped `response_item`
 * duplicates don't double-count.
 */
export function parseCodexTranscript(content: string, root: string): CodexTranscript {
  const messages: CodexMessage[] = [];
  let sessionId: string | undefined;
  // Stable, monotonic counters so messages without a natural id still dedupe
  // deterministically across re-imports of the same (append-only) rollout.
  let userSeq = 0;
  let asstSeq = 0;
  let planSeq = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = prop(obj, 'type');
    const payload = prop(obj, 'payload');
    const timestamp = asString(prop(obj, 'timestamp'));

    if (type === 'session_meta') {
      const id = asString(prop(payload, 'id'));
      if (id && !sessionId) sessionId = id;
      continue;
    }

    const pType = prop(payload, 'type');

    if (type === 'event_msg' && pType === 'user_message') {
      const text = asString(prop(payload, 'message'))?.trim();
      if (!text) continue;
      messages.push({
        role: 'user',
        text,
        timestamp,
        sourceId: `codex:user:${sessionId ?? '?'}:${userSeq++}`,
      });
    } else if (type === 'event_msg' && pType === 'agent_message') {
      const text = asString(prop(payload, 'message'))?.trim();
      if (!text) continue;
      messages.push({
        role: 'assistant',
        text,
        timestamp,
        sourceId: `codex:asst:${sessionId ?? '?'}:${asstSeq++}`,
      });
    } else if (type === 'response_item' && pType === 'custom_tool_call') {
      if (prop(payload, 'name') !== 'apply_patch') continue;
      const envelope = asString(prop(payload, 'input'));
      if (!envelope) continue;
      const files = filesFromEnvelope(envelope, root);
      if (files.length === 0) continue;
      const callId = asString(prop(payload, 'call_id'));
      messages.push({
        role: 'edit',
        text: `Codex edited ${files.join(', ')}`,
        files,
        timestamp,
        sourceId: callId
          ? `codex:edit:${callId}`
          : `codex:edit:${sessionId ?? '?'}:${messages.length}`,
      });
    } else if (type === 'response_item' && pType === 'function_call') {
      // Codex's plan/todo list. `arguments` is a JSON *string*: the steps live
      // under `plan: [{ step, status }]`, with an optional `explanation`. There's
      // no approval to resolve — Codex runs headless and never asks (the
      // function_call_output is a bare "Plan updated") — so the message stands
      // alone with no second pass.
      if (prop(payload, 'name') !== 'update_plan') continue;
      const text = renderCodexPlan(asString(prop(payload, 'arguments')));
      if (!text) continue;
      const callId = asString(prop(payload, 'call_id'));
      messages.push({
        role: 'plan',
        text,
        timestamp,
        sourceId: callId
          ? `codex:plan:${callId}`
          : `codex:plan:${sessionId ?? '?'}:${planSeq}`,
      });
      planSeq += 1;
    }
  }

  return {
    sessionId,
    title: sessionId ? `Codex session ${sessionId.slice(0, 8)}` : 'Codex session',
    messages,
  };
}

/**
 * Render Codex's `update_plan` arguments into readable plan markdown — an
 * optional explanation line followed by a checklist of steps, each marked by its
 * status (`completed` → checked, `in_progress` → arrow, anything else → empty
 * box). `arguments` is a JSON *string*; returns undefined for a missing/empty or
 * unparseable payload so the caller skips it.
 */
function renderCodexPlan(args: string | undefined): string | undefined {
  if (!args) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(args);
  } catch {
    return undefined;
  }
  const steps = asArray(prop(obj, 'plan'));
  if (!steps || steps.length === 0) return undefined;

  const lines: string[] = [];
  for (const item of steps) {
    const step = asString(prop(item, 'step'))?.trim();
    if (!step) continue;
    const status = asString(prop(item, 'status'));
    const mark = status === 'completed' ? '[x]' : status === 'in_progress' ? '[→]' : '[ ]';
    lines.push(`- ${mark} ${step}`);
  }
  if (lines.length === 0) return undefined;

  const explanation = asString(prop(obj, 'explanation'))?.trim();
  return explanation ? `${explanation}\n\n${lines.join('\n')}` : lines.join('\n');
}

/** Repo-relative, in-repo, non-internal file paths named by an apply_patch envelope. */
function filesFromEnvelope(envelope: string, root: string): string[] {
  const out: string[] = [];
  for (const m of envelope.matchAll(APPLY_PATCH_FILE_RE)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    const rel = toRepoRelative(root, raw);
    if (rel.startsWith('..') || isInternalPath(rel)) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * Parse a rollout into the tool-agnostic {@link HookTranscript} the generic stop
 * reconcile in commands/hook.ts consumes. `edit` messages are dropped — the
 * post-edit hook already records those — leaving prompts, assistant replies, and
 * plans. A Codex plan is always marked `approved` (Codex runs headless and never
 * asks for approval), so the reconcile tags it as an approved plan.
 */
export function parseCodexRollout(content: string, root: string): HookTranscript {
  const parsed = parseCodexTranscript(content, root);
  const messages: HookTranscriptMessage[] = [];
  for (const m of parsed.messages) {
    if (m.role === 'edit') continue;
    messages.push({
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      sourceId: m.sourceId,
      ...(m.role === 'plan' ? { approved: true } : {}),
    });
  }
  return { sessionId: parsed.sessionId, messages };
}

// --- Summaries (for the import picker) -------------------------------------

/**
 * Summarize every rollout for `author.shared.root`, newest first, so the picker
 * can show counts, a span, and first/last prompt. Each rollout is parsed once; a
 * rollout that fails to parse still appears (counts zeroed) so `--file` can reach
 * it. `importState` is computed against the trail's existing source ids.
 */
export function summarizeRollouts(author: AuthorPaths): CodexRolloutSummary[] {
  const seen = importedSourceIds(author);
  const root = author.shared.root;
  return findProjectRollouts(root).map((info) => {
    const summary: CodexRolloutSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: CodexTranscript;
    try {
      parsed = parseCodexTranscript(readFileSync(info.path, 'utf8'), root);
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

// --- Importing -------------------------------------------------------------

export interface CodexImportOptions {
  /** Also log Codex's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface CodexImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  plans: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed rollout into the trail. User prompts become `prompt` events,
 * assistant replies become `ai_output` (only with `withResponses`), and each AI
 * edit becomes a back-dated `artifact` event noting the file (not a hash
 * snapshot, since a past file's hash can't be recovered). Every event is tagged
 * `tool: codex` and `imported`, stamped with the original time, and deduped by
 * `sourceId` so re-importing adds nothing.
 *
 * Imports the {@link logEvent} machinery lazily here (same module as Claude's
 * importer) to keep the parser surface free of trail-write side effects.
 */
export async function importCodexTranscript(
  author: AuthorPaths,
  transcript: CodexTranscript,
  options: CodexImportOptions = {},
): Promise<CodexImportResult> {
  const { logEvent } = await import('./events.ts');
  const seen = importedSourceIds(author);
  const result: CodexImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    plans: 0,
    skipped: 0,
  };

  // A user prompt opens a turn; the reply/edits that follow link back via this id.
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
          : msg.role === 'plan'
            ? 'plan'
            : 'artifact';

    // Codex plans aren't approved (headless), so they always carry the
    // approved tag, mirroring how Claude tags an approved plan.
    const tags =
      msg.role === 'plan' ? ['imported', PLAN_APPROVED_TAG] : ['imported'];

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'codex',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      files: msg.files,
      tags,
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') currentTurnId = event.id;

    if (msg.role === 'user') result.prompts += 1;
    else if (msg.role === 'assistant') result.responses += 1;
    else if (msg.role === 'plan') result.plans += 1;
    else result.edits += 1;

    if (msg.timestamp) {
      if (!result.first || msg.timestamp < result.first) result.first = msg.timestamp;
      if (!result.last || msg.timestamp > result.last) result.last = msg.timestamp;
    }
  }

  return result;
}
