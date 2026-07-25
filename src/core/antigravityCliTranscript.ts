/**
 * Parse and discover Google Antigravity CLI (`agy`) session transcripts.
 *
 * Antigravity persists a JSONL transcript of every conversation — its "brain" —
 * at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
 * transcript.jsonl` (one JSON object per line). The directory name IS the
 * conversation/session id (it matches the `conversationId` recorded in
 * `~/.gemini/antigravity-cli/history.jsonl`). A sibling `transcript_full.jsonl`
 * carries the same lines with extra internals; we read the de-noised
 * `transcript.jsonl`.
 *
 * Mirrors src/core/codexTranscript.ts (parser + session discovery by id / newest
 * mtime + the `getTranscript` surface), adapted to Antigravity's vocabulary.
 *
 * Each line is `{ step_index, source, type, status, created_at, ... }`:
 *   - `USER_INPUT`        — the student's typed prompt. `content` is wrapped in
 *     `<USER_REQUEST>…</USER_REQUEST>` plus `<ADDITIONAL_METADATA>` chrome, which
 *     we strip to recover the raw prompt.
 *   - `PLANNER_RESPONSE`  — one assistant turn. When it carries text `content`
 *     (and no edit), that's the assistant's reply. When it carries `tool_calls`,
 *     it's invoking tools (edits, reads, commands). A plan-producing tool call
 *     (see PLAN_TOOL_NAMES) or a dedicated plan line (see PLAN_TYPES) becomes a
 *     'plan' message — Antigravity is plan-centric, so capturing its generated
 *     implementation plan / task list is the signature win.
 *   - `CODE_ACTION`       — a file the model edited (already captured live by the
 *     PostToolUse hook, so it's emitted as role 'edit' and dropped at reconcile).
 *   - `VIEW_FILE` / `LIST_DIRECTORY` / `RUN_COMMAND` / `CHECKPOINT` /
 *     `CONVERSATION_HISTORY` / `ERROR_MESSAGE` — tool reads, compaction state,
 *     and noise: ignored.
 *
 * NOTE ON DECISIONS: Antigravity's on-disk transcript has no AskUserQuestion-style
 * structured decision construct (no decision/choice line type or tool was found),
 * so — per the contract — we do NOT fabricate one. Decisions are skipped. If a
 * future `agy` adds an explicit ask/choice line, extend DECISION_TYPES below.
 *
 * Everything is local and best-effort: malformed lines are skipped, never thrown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostHome } from './hostHome.ts';
import { asArray, asString, isObject, prop } from './parse.ts';
import type {
  DiscoveredPlanFile,
  HookTranscript,
  HookTranscriptMessage,
} from '../plugins/types.ts';

/** A transcript file found on disk for an Antigravity conversation. */
export interface AntigravityCliTranscriptInfo {
  path: string;
  /** The conversation/session id (the brain directory name). */
  sessionId: string;
  mtimeMs: number;
}

/**
 * Line `type`s that represent a generated PLAN / task list as a first-class line
 * (some `agy` builds emit one). Guarded by existence: if none appear, plans are
 * still recovered from plan-producing tool calls (PLAN_TOOL_NAMES).
 */
const PLAN_TYPES = new Set(['PLAN', 'PLAN_RESPONSE', 'TASK_LIST', 'PLAN_UPDATE']);

/**
 * `PLANNER_RESPONSE` `tool_calls[].name`s that create/update Antigravity's plan
 * (its implementation plan / task list artifact). The model proposes the plan by
 * calling one of these; its arguments hold the plan markdown / task list. Names
 * are matched case-insensitively and may be version-fragile, so we cast a wide,
 * conservative net rather than rely on a single literal.
 */
const PLAN_TOOL_NAMES = new Set([
  'create_plan',
  'update_plan',
  'write_plan',
  'set_plan',
  'plan',
  'create_task_list',
  'update_task_list',
  'write_task_list',
  'task_list',
  'update_tasks',
]);

/**
 * File-writing tool calls that, when their target is a plan artifact (see
 * PLAN_FILE_NAMES), create the session's plan. Antigravity *IDE* has no
 * `create_plan`-style tool — it writes its implementation plan to a markdown file
 * with `write_to_file`, so that write IS the plan event. We only treat a full
 * `write_to_file` as a plan (it carries the whole plan in `CodeContent`);
 * incremental `replace_file_content` edits carry only diffs and are reflected via
 * the canonical on-disk file the `planFiles` hook surfaces instead.
 */
const PLAN_FILE_WRITE_TOOLS = new Set(['write_to_file']);

/**
 * Basenames Antigravity uses for its plan artifact: the IDE writes
 * `implementation_plan.md`; the CLI's canonical file is `plan.md`. Matched on the
 * write target's basename (case-insensitively), separator-agnostic.
 */
const PLAN_FILE_NAMES = new Set(['implementation_plan.md', 'plan.md']);

/**
 * Decision/ask constructs. EMPTY by design: the real transcript carries no
 * structured decision line. Kept as the single extension point so a future `agy`
 * ask/choice line can be wired in without re-deriving the parser shape.
 */
const DECISION_TYPES = new Set<string>([]);

// --- Locating transcripts on disk -----------------------------------------

/**
 * The base `~/.gemini` dir, honoring a home override. Antigravity shares
 * `~/.gemini` with other tools; respect the same env knobs `agy` reads so
 * a relocated home is found.
 */
export function geminiHome(): string {
  // `agy` accepts several names for this one directory; check them in the order
  // it does. The last step — `GEMINI_HOME` else `~/.gemini` — is the override
  // pattern every host tool shares, so it goes through `hostHome`.
  const alias = process.env.ANTIGRAVITY_HOME || process.env.GEMINI_HOME;
  if (alias && alias.length > 0) return alias;
  const legacy = process.env.GEMINI_CONFIG_DIR;
  if (legacy && legacy.length > 0) return legacy;
  return hostHome('GEMINI_HOME', '.gemini');
}

/** The dir Antigravity stores per-conversation brains under. */
export function antigravityCliBrainDir(): string {
  return join(geminiHome(), 'antigravity-cli', 'brain');
}

/** The transcript path inside a brain dir, given the conversation id. */
function transcriptPathFor(brainDir: string, sessionId: string): string {
  return join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
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
 * Find every Antigravity transcript on disk, newest first. The brain layout is
 * `brain/<conversationId>/.system_generated/logs/transcript.jsonl`, so we list
 * the conversation dirs and check each expected transcript path (guarded — paths
 * are version-fragile, so a missing file is simply skipped). The conversation id
 * is the dir name. Unlike Claude/Codex, the transcript lines carry no embedded
 * `cwd`, so there's no per-project filtering here; the caller selects by the
 * Stop payload's session id, else the newest.
 */
export function findAntigravityCliTranscripts(): AntigravityCliTranscriptInfo[] {
  return findTranscriptsUnderBrain(antigravityCliBrainDir());
}

/**
 * The generic brain-dir scan shared by the Antigravity CLI and IDE readers (both
 * use the identical `brain/<id>/.system_generated/logs/transcript.jsonl` layout;
 * only the product dir under `~/.gemini` differs). Lists conversation dirs under
 * `brainDir`, checks each expected transcript path (guarded — a missing file is
 * simply skipped), and returns them newest first. The conversation id is the dir
 * name; the lines carry no embedded `cwd`, so the caller selects by the Stop
 * payload's session id, else the newest.
 */
export function findTranscriptsUnderBrain(
  brainDir: string,
): AntigravityCliTranscriptInfo[] {
  if (!existsSync(brainDir)) return [];
  const out: AntigravityCliTranscriptInfo[] = [];

  for (const entry of safeReaddir(brainDir)) {
    const convoDir = join(brainDir, entry);
    if (!isDir(convoDir)) continue;
    const path = transcriptPathFor(brainDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue; // No transcript yet (or a different layout) — skip.
    }
    if (!st.isFile()) continue;
    out.push({ path, sessionId: entry, mtimeMs: st.mtimeMs });
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Locate the transcript for a Stop payload: prefer the conversation whose id
 * matches the payload's session id; otherwise the most recently modified
 * transcript (the just-stopped session). Returns null when nothing's on disk.
 */
export function locateAntigravityCliTranscript(
  sessionId: string | undefined,
): AntigravityCliTranscriptInfo | null {
  const all = findAntigravityCliTranscripts();
  if (all.length === 0) return null;
  if (sessionId) {
    const byId = all.find((t) => t.sessionId === sessionId);
    if (byId) return byId;
  }
  return all[0]!; // newest first
}

/**
 * The on-disk plan file Antigravity wrote for a session, if any. agy keeps the
 * student's implementation plan / task list at
 * `~/.gemini/antigravity-cli/brain/<conversationId>/plan.md`, overwriting it as
 * the plan evolves — so the single file is the session's canonical plan. Returns
 * `[]` when no session id resolves or no plan.md exists. Best-effort; never throws.
 */
export function antigravityCliPlanFiles(
  sessionId: string | undefined,
): DiscoveredPlanFile[] {
  const sid = sessionId || findAntigravityCliTranscripts()[0]?.sessionId;
  if (!sid) return [];
  const file = join(antigravityCliBrainDir(), sid, 'plan.md');
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, 'utf8').trim();
    if (!content) return [];
    return [
      { absPath: file, content, sourceId: `agy-plan:${sid}`, nativeSessionId: sid },
    ];
  } catch {
    return [];
  }
}

// --- Parsing ---------------------------------------------------------------

/** Strip Antigravity's `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` chrome off a prompt. */
function cleanUserContent(raw: string): string {
  let text = raw;
  // Prefer the explicit request block when present.
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
  if (m) {
    text = m[1]!;
  } else {
    // No closing tag (older/truncated): drop a leading open tag if any.
    text = text.replace(/^\s*<USER_REQUEST>\s*/i, '');
  }
  // Drop any trailing metadata block the request didn't already exclude.
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '');
  return text.trim();
}

/** Pull a plan's markdown / task list out of a plan tool call's args (best-effort). */
function planTextFromToolCall(call: unknown): string | undefined {
  const args = prop(call, 'args');
  // Common arg keys an Antigravity plan tool might carry the plan under.
  for (const key of [
    'plan',
    'content',
    'markdown',
    'text',
    'body',
    'task_list',
    'tasks',
  ]) {
    const v = prop(args, key);
    const s = asString(v)?.trim();
    if (s) return s;
    // A task list may be an array of step strings/objects — render it.
    const arr = asArray(v);
    if (arr && arr.length > 0) {
      const lines = arr
        .map((item) => {
          const t =
            asString(item) ??
            asString(prop(item, 'title')) ??
            asString(prop(item, 'name')) ??
            asString(prop(item, 'description'));
          return t ? `- ${t.trim()}` : undefined;
        })
        .filter((x): x is string => !!x);
      if (lines.length > 0) return lines.join('\n');
    }
  }
  // Whole-args fallback: a structured plan with no obvious text key.
  if (isObject(args)) {
    try {
      const s = JSON.stringify(args, null, 2);
      if (s && s !== '{}') return s;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Antigravity IDE tool-call arg values arrive JSON-string-**double-encoded** — a
 * string arg reads as `"\"# Title\\n…\""`, a path as `"\"C:\\\\…\""`. Recover the
 * real value: if it's wrapped in quotes, JSON.parse it (guarded); else return as
 * is. Harmless on already-plain CLI args (they aren't quote-wrapped).
 */
function unwrapAgyArg(value: unknown): string | undefined {
  const s = asString(value);
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* fall through — use the raw string */
    }
  }
  return s;
}

/** The final path segment, splitting on both `/` and `\` (real data uses both). */
function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * If `call` is a `write_to_file` whose target is a plan artifact (see
 * PLAN_FILE_NAMES), return the plan markdown it wrote; otherwise undefined. This
 * is how the IDE's implementation plan is recognized — it has no plan tool, it
 * writes `implementation_plan.md`.
 */
function planTextFromFileWrite(call: unknown): string | undefined {
  const name = asString(prop(call, 'name'))?.toLowerCase();
  if (!name || !PLAN_FILE_WRITE_TOOLS.has(name)) return undefined;
  const args = prop(call, 'args');
  const target = unwrapAgyArg(prop(args, 'TargetFile') ?? prop(args, 'target_file'));
  if (!target) return undefined;
  if (!PLAN_FILE_NAMES.has(pathBasename(target).toLowerCase())) return undefined;
  // The full plan is in `CodeContent`; fall back to the generic plan-text keys.
  const content = unwrapAgyArg(prop(args, 'CodeContent'))?.trim();
  if (content) return content;
  return planTextFromToolCall(call);
}

/**
 * Drop unusable links to Antigravity's plan artifact from an assistant reply. The
 * IDE announces its plan with `[implementation_plan.md](file:///…/brain/<id>/
 * implementation_plan.md)` — an absolute path into the user's private brain dir
 * that the report can't resolve (and the HTML renderer won't even linkify), so it
 * renders as a long dead path. The plan is captured as a first-class Plan with its
 * own link, so we flatten the announcement link to just its label.
 */
function sanitizePlanFileLinks(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\(file:\/\/[^)]*?(?:implementation_plan|plan)\.md\)/gi,
    '$1',
  );
}

/** Render a plan carried directly on a PLAN-type line (content / structured). */
function planTextFromLine(obj: unknown): string | undefined {
  const content = asString(prop(obj, 'content'))?.trim();
  if (content) return content;
  const plan = asString(prop(obj, 'plan'))?.trim();
  if (plan) return plan;
  return undefined;
}

/**
 * Parse an Antigravity transcript JSONL into the tool-agnostic
 * {@link HookTranscript} the generic stop reconcile in commands/hook.ts consumes.
 *
 * Emits 'user' (cleaned prompt), 'assistant' (planner text reply), 'plan' (the
 * generated implementation plan / task list, approved when the transcript records
 * it), and 'edit' (CODE_ACTION — dropped by the reconcile, kept for parity).
 * Decisions are not emitted (no construct exists; see module header). Malformed
 * lines are skipped. `sessionId` is supplied by the caller (the brain dir name),
 * since the lines themselves carry none.
 */
export function parseAntigravityCliTranscript(
  content: string,
  root: string,
  sessionId?: string,
): HookTranscript {
  const messages: HookTranscriptMessage[] = [];
  const sid = sessionId ?? '?';
  // Stable, monotonic counters keyed by step_index when present (Antigravity's
  // own per-turn index), else a running fallback, so re-reads of the same
  // append-only transcript dedupe deterministically.
  let seq = 0;
  // Antigravity records no per-message model, but each USER_INPUT embeds a
  // `<USER_SETTINGS_CHANGE>` note "Model Selection ... to <model>" when the model
  // is chosen/changed (already human-readable, e.g. "Gemini 3.5 Flash (Medium)").
  // Track the latest and stamp it on the MODEL-sourced replies/plans that follow.
  let currentModel: string | undefined;

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
    if (!type) continue;
    const timestamp = asString(prop(obj, 'created_at'));
    const stepIndex = prop(obj, 'step_index');
    const idx = typeof stepIndex === 'number' ? String(stepIndex) : `n${seq++}`;

    if (type === 'USER_INPUT') {
      const raw = asString(prop(obj, 'content')) ?? '';
      // Pick up a model choice/switch embedded in the settings-change note, e.g.
      // "...`Model Selection` from None to Gemini 3.5 Flash (Medium). No need...".
      // Stop at the sentence-ending ". " (or newline/end) — not the version dot in
      // "3.5", so the full "Gemini 3.5 Flash (Medium)" is captured.
      const m = /Model Selection[^\n]*?\bto\s+(.+?)(?:\.\s|\.$|\n|$)/.exec(raw);
      if (m) currentModel = m[1]!.trim();
      const text = cleanUserContent(raw);
      if (!text) continue;
      messages.push({
        role: 'user',
        text,
        timestamp,
        sourceId: `agy:user:${sid}:${idx}`,
      });
      continue;
    }

    if (PLAN_TYPES.has(type)) {
      const text = planTextFromLine(obj);
      if (!text) continue;
      // A plan line may carry its own approval; the transcript here records
      // accepted plans, so treat a present plan line as approved unless flagged.
      const status = asString(prop(obj, 'status'));
      const approved = status !== 'REJECTED' && status !== 'REVISED';
      messages.push({
        role: 'plan',
        text,
        timestamp,
        sourceId: `agy:plan:${sid}:${idx}`,
        approved,
        model: currentModel,
      });
      continue;
    }

    if (DECISION_TYPES.has(type)) {
      // Reserved: no decision construct exists in the real transcript today.
      continue;
    }

    if (type === 'CODE_ACTION') {
      // An edit. The PostToolUse hook already snapshots these live, so the
      // reconcile drops role:'edit'; we emit it for parity with the Codex reader.
      messages.push({
        role: 'edit',
        text: 'Antigravity edited a file',
        timestamp,
        sourceId: `agy:edit:${sid}:${idx}`,
      });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const calls = asArray(prop(obj, 'tool_calls')) ?? [];

      // A plan-producing tool call → a 'plan' message (Antigravity's signature).
      // Either a dedicated plan tool (CLI) or a write to the plan artifact file
      // (IDE: `write_to_file` → implementation_plan.md).
      let emittedPlan = false;
      for (let i = 0; i < calls.length; i++) {
        const name = asString(prop(calls[i], 'name'))?.toLowerCase();
        if (!name) continue;
        const text = PLAN_TOOL_NAMES.has(name)
          ? planTextFromToolCall(calls[i])
          : planTextFromFileWrite(calls[i]);
        if (!text) continue;
        messages.push({
          role: 'plan',
          text,
          timestamp,
          sourceId: `agy:plan:${sid}:${idx}:${i}`,
          approved: true, // a recorded plan call is one the run proceeded on
          model: currentModel,
        });
        emittedPlan = true;
      }
      if (emittedPlan) continue;

      // Otherwise: a text reply (content present, not a tool-only turn). Strip any
      // dead link to the plan artifact file — the plan is captured separately above.
      const text = asString(prop(obj, 'content'))?.trim();
      if (text) {
        messages.push({
          role: 'assistant',
          text: sanitizePlanFileLinks(text),
          timestamp,
          sourceId: `agy:asst:${sid}:${idx}`,
          model: currentModel,
        });
      }
      // tool-only PLANNER_RESPONSE turns (edits/reads/commands) carry no reply
      // text; the edits are handled via CODE_ACTION lines, so nothing to emit.
      continue;
    }

    // Everything else (VIEW_FILE, LIST_DIRECTORY, RUN_COMMAND, CHECKPOINT,
    // CONVERSATION_HISTORY, ERROR_MESSAGE, …) is tool noise — ignored.
  }

  // Drop 'edit' messages: the post-edit hook already records those, and the
  // generic reconcile ignores them. Keeping the transcript lean mirrors
  // parseCodexRollout.
  const kept = messages.filter((m) => m.role !== 'edit');
  void root; // root is accepted for signature parity (edits use it); reserved.
  return { sessionId, messages: kept };
}

/** Read a transcript file from disk and parse it. */
export function readAntigravityCliTranscript(
  info: AntigravityCliTranscriptInfo,
  root: string,
): HookTranscript {
  if (!existsSync(info.path)) {
    throw new Error(`Antigravity transcript not found: ${info.path}`);
  }
  return parseAntigravityCliTranscript(
    readFileSync(info.path, 'utf8'),
    root,
    info.sessionId,
  );
}
