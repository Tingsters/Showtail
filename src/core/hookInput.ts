/**
 * Parsing for the JSON that Claude Code sends to a hook on **stdin**.
 *
 * We only read the few fields we need and treat everything as best-effort: a
 * hook must never crash a Claude session, so callers fall back to safe no-ops
 * when anything is missing or malformed.
 */

/** The subset of a Claude Code hook payload that Showtail cares about. */
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

/** Extract the Claude Code session id, or undefined if absent/empty. */
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
 * Extract the file path(s) an Edit/Write/MultiEdit tool touched.
 * All three put the target in `tool_input.file_path`; we also tolerate a
 * `file_paths` array just in case.
 */
export function extractEditedFiles(payload: HookPayload): string[] {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return [];

  const out: string[] = [];
  const single = (input as Record<string, unknown>).file_path;
  if (typeof single === 'string' && single.length > 0) out.push(single);

  const many = (input as Record<string, unknown>).file_paths;
  if (Array.isArray(many)) {
    for (const p of many) {
      if (typeof p === 'string' && p.length > 0) out.push(p);
    }
  }
  // De-dupe while preserving order.
  return [...new Set(out)];
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
      if (path) out.push(path);
    }
  }

  const changes = obj.changes;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const path of Object.keys(changes)) {
      if (path.length > 0) out.push(path);
    }
  }

  const single = obj.file_path;
  if (typeof single === 'string' && single.length > 0) out.push(single);

  // De-dupe while preserving order.
  return [...new Set(out)];
}
