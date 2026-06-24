/**
 * Generic parsing for the JSON a connected tool sends to a hook on **stdin**.
 * Each plugin's hook adapter calls these helpers; the shapes here are the common
 * fields most tools share.
 *
 * We only read the few fields we need and treat everything as best-effort: a
 * hook must never crash the host session, so callers fall back to safe no-ops
 * when anything is missing or malformed.
 */

import { isAbsolute, relative } from 'node:path';

/** The subset of a hook payload that Showtail cares about. */
export interface HookPayload {
  hook_event_name?: string;
  /** Working directory of the session (the project root, usually). */
  cwd?: string;
  /** UserPromptSubmit: the prompt the student submitted. */
  prompt?: string;
  /** PreToolUse / PostToolUse: which tool ran. */
  tool_name?: string;
  /** PreToolUse / PostToolUse: the tool's arguments. */
  tool_input?: Record<string, unknown>;
  /** SessionStart: "startup" | "resume" | "compact" | ... */
  source?: string;
  /** Stop: absolute path to the session transcript (Claude Code provides this). */
  transcript_path?: string;
  /**
   * The Claude Code session this hook fired for. Sent on every payload, stable
   * across the session's lifetime; lets Showtail keep one trail per real
   * session even when several run/restart concurrently.
   */
  session_id?: string;
}

/** Read all of stdin and parse it as JSON. Returns null if empty/invalid. */
export async function readHookPayload(): Promise<HookPayload | null> {
  try {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as HookPayload;
  } catch {
    return null;
  }
}

/** Extract the host tool's session id, or undefined if absent/empty. */
export function extractSessionId(payload: HookPayload | null): string | undefined {
  const id = payload?.session_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Extract the submitted prompt text, or null if absent/empty. */
export function extractPrompt(payload: HookPayload): string | null {
  const text = payload.prompt;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a file path extracted from a hook payload to repo-relative.
 *
 * Real Codex `apply_patch` envelopes (and some Edit payloads) carry ABSOLUTE
 * file paths. The downstream artifact snapshot resolves the path against the
 * repo root, so an absolute path that happens not to live under `root` — or that
 * uses different separators/casing — silently fails to match. We make absolute
 * paths relative to the payload's `cwd` (the session root) here, normalizing to
 * posix separators so the path matches regardless of platform. Already-relative
 * paths are returned unchanged.
 */
function normalizeHookPath(path: string, cwd: string | undefined): string {
  if (!isAbsolute(path)) return path.replace(/\\/g, '/');
  if (!cwd) return path.replace(/\\/g, '/');
  const rel = relative(cwd, path);
  // If the path escapes cwd, `relative` yields `..`; keep it as-is (posix) so the
  // downstream repo-relative guard can reject it rather than silently mangling it.
  return rel.replace(/\\/g, '/');
}

/**
 * Extract the file path(s) an Edit/Write/MultiEdit tool touched.
 * All three put the target in `tool_input.file_path`; we also tolerate a
 * `file_paths` array just in case. Absolute paths are normalized to
 * repo-relative against the payload's `cwd` (see {@link normalizeHookPath}).
 */
export function extractEditedFiles(payload: HookPayload): string[] {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return [];

  const out: string[] = [];
  const single = (input as Record<string, unknown>).file_path;
  if (typeof single === 'string' && single.length > 0) {
    out.push(normalizeHookPath(single, payload.cwd));
  }

  const many = (input as Record<string, unknown>).file_paths;
  if (Array.isArray(many)) {
    for (const p of many) {
      if (typeof p === 'string' && p.length > 0) {
        out.push(normalizeHookPath(p, payload.cwd));
      }
    }
  }
  // De-dupe while preserving order.
  return [...new Set(out)];
}

/**
 * Extract edited file path(s) from an Antigravity IDE PostToolUse payload. Its
 * edit tools (write_to_file / replace_file_content / multi_replace_file_content /
 * create_file / …) put the path in `args.TargetFile` (PascalCase), and the IDE
 * JSON-string-encodes arg values (e.g. `"\"C:/x.py\""`). The stdin wrapper may
 * nest the args under `toolCall.args`, `tool_input`, or `args`, so we check each.
 * Absolute paths are normalized repo-relative against `cwd`. Best-effort.
 */
export function extractAntigravityEditedFiles(payload: HookPayload): string[] {
  const p = payload as unknown as Record<string, unknown>;
  const fromToolCall =
    p.toolCall && typeof p.toolCall === 'object'
      ? (p.toolCall as Record<string, unknown>).args
      : undefined;
  const args = [fromToolCall, p.tool_input, p.args].find(
    (a): a is Record<string, unknown> => !!a && typeof a === 'object',
  );
  if (!args) return [];
  for (const key of [
    'TargetFile',
    'target_file',
    'AbsolutePath',
    'file_path',
    'path',
    'Path',
  ]) {
    const decoded = decodeMaybeJsonString(args[key]);
    if (decoded) return [normalizeHookPath(decoded, payload.cwd)];
  }
  return [];
}

/** Unwrap a possibly JSON-string-encoded scalar (Antigravity double-encodes arg values). */
function decodeMaybeJsonString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (s.length === 0) return null;
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner: unknown = JSON.parse(s);
      if (typeof inner === 'string') s = inner.trim();
    } catch {
      /* not JSON-encoded — use the raw value */
    }
  }
  return s.length > 0 ? s : null;
}

/** Render a minimal +/- diff from an Edit's old/new strings. */
function simpleDiff(oldStr: unknown, newStr: unknown): string {
  const out: string[] = [];
  if (typeof oldStr === 'string' && oldStr.length > 0) {
    for (const l of oldStr.split('\n')) out.push('- ' + l);
  }
  if (typeof newStr === 'string' && newStr.length > 0) {
    for (const l of newStr.split('\n')) out.push('+ ' + l);
  }
  return out.join('\n');
}

/**
 * Extract the AI-suggested code that produced an edit, as a small diff or
 * snippet, from a PostToolUse payload. Handles Claude's Edit (old→new), Write
 * (full new content), and MultiEdit (each edit), plus Codex's apply_patch
 * envelope. Returns undefined when there's nothing to capture.
 */
export function extractSuggestedCode(payload: HookPayload): string | undefined {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  // Codex apply_patch: the envelope text is already a +/- diff.
  for (const key of ['input', 'patch'] as const) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) {
      return obj[key] as string;
    }
  }

  // MultiEdit: an array of {old_string, new_string}.
  if (Array.isArray(obj.edits)) {
    const parts: string[] = [];
    for (const e of obj.edits) {
      if (e && typeof e === 'object') {
        const r = e as Record<string, unknown>;
        const d = simpleDiff(r.old_string, r.new_string);
        if (d) parts.push(d);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  // Edit: old_string → new_string.
  if ('old_string' in obj || 'new_string' in obj) {
    const d = simpleDiff(obj.old_string, obj.new_string);
    return d || undefined;
  }

  // Write: the whole new file content, shown as added lines.
  if (typeof obj.content === 'string' && obj.content.length > 0) {
    return simpleDiff(undefined, obj.content);
  }

  return undefined;
}

// Matches the file headers in an apply_patch envelope, e.g.
//   *** Add File: src/foo.ts
//   *** Update File: src/foo.ts
//   *** Move File: src/old.ts
// We capture Add/Update/Move (the file exists after the patch) and skip Delete.
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Move) File: (.+)$/gm;

/**
 * Extract the file path(s) Codex's `apply_patch` tool touched. Codex has no
 * Edit/Write tool; it edits via an apply-patch envelope whose text lives in the
 * tool input. We tolerate several shapes for where that text/paths sit:
 *  - `tool_input.input` / `tool_input.patch`: the raw envelope text;
 *  - `tool_input.changes`: an object keyed by path;
 *  - `tool_input.file_path`: a plain path (defensive).
 * Deleted files are skipped (they no longer exist to snapshot).
 */
export function extractApplyPatchFiles(payload: HookPayload): string[] {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];

  for (const key of ['input', 'patch'] as const) {
    const text = obj[key];
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(APPLY_PATCH_FILE_RE)) {
      const path = m[1]?.trim();
      // Real Codex envelopes carry absolute paths; normalize to repo-relative so
      // the downstream snapshot resolves correctly (otherwise it silently fails).
      if (path) out.push(normalizeHookPath(path, payload.cwd));
    }
  }

  const changes = obj.changes;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const path of Object.keys(changes)) {
      if (path.length > 0) out.push(normalizeHookPath(path, payload.cwd));
    }
  }

  const single = obj.file_path;
  if (typeof single === 'string' && single.length > 0) {
    out.push(normalizeHookPath(single, payload.cwd));
  }

  // De-dupe while preserving order.
  return [...new Set(out)];
}

// --- Antigravity CLI (`agy`) payloads --------------------------------------
// agy sends a different shape than Claude/Codex (verified live against agy
// 1.0.10): `{ toolCall: { name, args }, transcriptPath, conversationId,
// workspacePaths: [root] }`. Its edit tools (write_to_file / replace_file_content
// / …) carry the file under `args.TargetFile` and the new code under
// `args.CodeContent`; paths are absolute, normalized against `workspacePaths[0]`.

/** The subset of an Antigravity CLI hook payload Showtail reads. */
export interface AgyHookPayload {
  conversationId?: string;
  transcriptPath?: string;
  workspacePaths?: unknown;
  toolCall?: { name?: unknown; args?: Record<string, unknown> };
  // PreInvocation may surface the prompt under one of these (best-effort).
  prompt?: unknown;
  userMessage?: unknown;
  message?: unknown;
  userInput?: unknown;
}

const AGY_FILE_KEYS = ['TargetFile', 'FilePath', 'file_path', 'path', 'Path'] as const;
const AGY_CODE_KEYS = [
  'CodeContent',
  'ReplacementContent',
  'NewContent',
  'content',
] as const;

function agyWorkspaceRoot(p: AgyHookPayload): string | undefined {
  const ws = p.workspacePaths;
  if (Array.isArray(ws) && typeof ws[0] === 'string') return ws[0];
  return undefined;
}

/** File(s) an agy edit tool touched, repo-relative (from `toolCall.args.TargetFile`). */
export function extractAgyEditedFiles(p: AgyHookPayload): string[] {
  const args = p.toolCall?.args;
  if (!args || typeof args !== 'object') return [];
  const root = agyWorkspaceRoot(p);
  const out: string[] = [];
  for (const k of AGY_FILE_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) out.push(normalizeHookPath(v, root));
  }
  return [...new Set(out)];
}

/** AI-suggested code for an agy edit (from `toolCall.args.CodeContent`). */
export function extractAgySuggestedCode(p: AgyHookPayload): string | undefined {
  const args = p.toolCall?.args;
  if (!args || typeof args !== 'object') return undefined;
  for (const k of AGY_CODE_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return simpleDiff(undefined, v);
  }
  return undefined;
}

/** The submitted prompt from an agy PreInvocation payload, best-effort. */
export function extractAgyPrompt(p: AgyHookPayload): string | undefined {
  for (const k of ['prompt', 'userMessage', 'message', 'userInput'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** agy's session id (the conversation / brain dir name). */
export function extractAgySessionId(p: AgyHookPayload): string | undefined {
  const id = p.conversationId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The transcript path agy hands every hook (points at its session JSONL). */
export function extractAgyTranscriptPath(p: AgyHookPayload): string | undefined {
  const t = p.transcriptPath;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}
