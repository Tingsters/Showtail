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
