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

/**
 * One file an edit touched, with its own diff — richer than a bare path so the
 * report can render per-file changes (and deletions) the same way for every
 * tool. Hosts that give file-level detail (Codex `apply_patch`) populate this;
 * tools that don't fall back to `editedFiles` + a single `suggestedDiff`.
 */
export interface EditedFile {
  /** Repo-relative path the edit touched. */
  file: string;
  /** Claude-style +/- diff for THIS file; omitted for deletions and bare snapshots. */
  diff?: string;
  /** The file was removed; the caller reconstructs the removed content as the diff. */
  deleted?: boolean;
}

/** The subset of a hook payload that Showtail cares about. */
export interface HookPayload {
  hook_event_name?: string;
  /** Working directory of the session (the project root, usually). */
  cwd?: string;
  /** UserPromptSubmit: the prompt the student submitted. */
  prompt?: string;
  /** PreToolUse / PostToolUse: which tool ran. */
  tool_name?: string;
  /**
   * PreToolUse / PostToolUse: the tool's arguments. Usually an object (Claude
   * Edit/Write, Codex `apply_patch` under `.input`), but Codex `custom_tool_call`
   * tools — including `apply_patch` — deliver the raw envelope as a flat STRING
   * here instead of an object, so callers must tolerate both.
   */
  tool_input?: Record<string, unknown> | string;
  /**
   * Codex `custom_tool_call` payloads are flat: the tool name lives in `name`
   * and the raw argument string (for apply_patch, the patch envelope) lives in
   * `input` (`arguments` is null). We read these as fallbacks to
   * `tool_name` / `tool_input` so apply_patch edits are captured.
   */
  name?: string;
  input?: unknown;
  arguments?: unknown;
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
  // Codex apply_patch: the envelope text is already a +/- diff. It may arrive
  // flat (top-level `input`) or nested, so reuse the same collector the file
  // extractor uses — otherwise the captured code would be empty for the common
  // flat custom_tool_call shape even when the file is snapshotted.
  const [envelope] = applyPatchEnvelopes(payload);
  if (envelope) return envelope;

  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

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
 * Collect every place an `apply_patch` envelope text might live in a payload.
 *
 * Codex delivers apply_patch in two shapes we've observed live:
 *  - `custom_tool_call` (the common one): a FLAT payload where the envelope is a
 *    top-level `input` string and the tool is named in `name` (`arguments` null,
 *    `tool_input` absent). Earlier code only read a nested object and silently
 *    dropped this — the reason Codex edits weren't captured.
 *  - nested object: the envelope under `tool_input.input` / `tool_input.patch`,
 *    or `tool_input` itself handed over as a raw string.
 * We gather all candidates and let the caller scan them; order doesn't matter
 * because results are de-duped.
 */
function applyPatchEnvelopes(payload: HookPayload): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  };
  const ti = payload.tool_input as unknown;
  push(ti); // `tool_input` handed over as a raw string
  if (ti && typeof ti === 'object') {
    const obj = ti as Record<string, unknown>;
    push(obj.input);
    push(obj.patch);
  }
  // Flat custom_tool_call: envelope at the top level.
  push(payload.input);
  push(payload.arguments);
  return out;
}

/**
 * Extract the file path(s) Codex's `apply_patch` tool touched. Codex has no
 * Edit/Write tool; it edits via an apply-patch envelope. The envelope text may
 * arrive flat (top-level `input`) or nested (`tool_input.input`/`.patch`, or
 * `tool_input` as a raw string) — see {@link applyPatchEnvelopes}. We also
 * tolerate a `tool_input.changes` object keyed by path and a defensive
 * `tool_input.file_path`. Deleted files are skipped (nothing to snapshot).
 */
export function extractApplyPatchFiles(payload: HookPayload): string[] {
  const out: string[] = [];

  for (const text of applyPatchEnvelopes(payload)) {
    for (const m of text.matchAll(APPLY_PATCH_FILE_RE)) {
      const path = m[1]?.trim();
      // Envelope paths may be absolute or repo-relative; normalize either way so
      // the downstream snapshot resolves correctly (otherwise it silently fails).
      if (path) out.push(normalizeHookPath(path, payload.cwd));
    }
  }

  const input = payload.tool_input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
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
  }

  // De-dupe while preserving order.
  return [...new Set(out)];
}

// Section header inside an apply_patch envelope, capturing op + path, e.g.
//   *** Add File: src/foo.ts   /   *** Delete File: old.ts
const APPLY_PATCH_HEADER_RE = /^\*\*\* (Add|Update|Move|Delete) File: (.+)$/;

/** Strip `@@`/context lines and reformat `+x`/`-x` to Claude's `+ x`/`- x`. */
function cleanPatchBody(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.startsWith('@@')) continue; // hunk marker — not shown by Claude
    if (l.startsWith('+')) out.push('+ ' + l.slice(1));
    else if (l.startsWith('-')) out.push('- ' + l.slice(1));
    // Context lines (space-prefixed or bare) are dropped to match Claude's
    // old→new style, which shows only changed lines.
  }
  return out.join('\n');
}

/**
 * Parse ONE apply_patch envelope into per-file edits with CLEAN, Claude-style
 * diffs: Add → `+ ` lines; Update/Move → `+ `/`- ` only (no `@@`/context);
 * Delete → `{ deleted: true }`. `normalize` maps an envelope path to the
 * repo-relative form the caller stores. Shared by the live hook
 * ({@link applyPatchEdits}) and the rollout reconcile (codexTranscript), so both
 * render identically. Files appearing twice keep the richer (diff/deletion) entry.
 */
export function editsFromEnvelope(
  envelope: string,
  normalize: (p: string) => string,
): EditedFile[] {
  const byFile = new Map<string, EditedFile>();
  const put = (edit: EditedFile) => {
    const prev = byFile.get(edit.file);
    if (!prev || (!prev.deleted && !prev.diff)) byFile.set(edit.file, edit);
  };
  let cur: { file: string; op: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const file = normalize(cur.file);
    if (cur.op === 'Delete') {
      put({ file, deleted: true });
    } else {
      const diff = cleanPatchBody(cur.lines);
      put({ file, diff: diff.length > 0 ? diff : undefined });
    }
    cur = null;
  };
  for (const raw of envelope.split('\n')) {
    const h = raw.match(APPLY_PATCH_HEADER_RE);
    if (h) {
      flush();
      cur = { file: h[2]!.trim(), op: h[1]!, lines: [] };
      continue;
    }
    if (raw.startsWith('*** ')) {
      // `*** Begin Patch` / `*** End Patch` — section boundary.
      flush();
      continue;
    }
    if (cur) cur.lines.push(raw);
  }
  flush();
  return [...byFile.values()];
}

/**
 * Convert a Codex `apply_patch` payload into per-file edits carrying CLEAN,
 * Claude-style diffs — so the report renders Codex edits the same way it renders
 * Claude's. Per file:
 *  - **Add** → all `+ ` lines (matches Claude's Write of a new file);
 *  - **Update/Move** → `+ `/`- ` lines only (no `@@`, no context);
 *  - **Delete** → `{ deleted: true }` (the envelope has no body; the caller
 *    reconstructs the removed content from the file's earlier snapshot).
 * Also folds in the structured `changes`/`file_path` forms as bare entries so
 * nothing the path extractor sees is dropped.
 */
export function applyPatchEdits(payload: HookPayload): EditedFile[] {
  const byFile = new Map<string, EditedFile>();
  const put = (edit: EditedFile) => {
    const prev = byFile.get(edit.file);
    // Prefer a richer entry: a deletion or a diff beats a bare path.
    if (!prev || (!prev.deleted && !prev.diff)) byFile.set(edit.file, edit);
  };

  const normalize = (p: string) => normalizeHookPath(p, payload.cwd);
  for (const envelope of applyPatchEnvelopes(payload)) {
    for (const e of editsFromEnvelope(envelope, normalize)) put(e);
  }

  // Defensive structured forms (no diff): keep them as bare entries.
  const input = payload.tool_input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const changes = obj.changes;
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      for (const p of Object.keys(changes)) {
        if (p.length > 0) put({ file: normalize(p) });
      }
    }
    const single = obj.file_path;
    if (typeof single === 'string' && single.length > 0) {
      put({ file: normalize(single) });
    }
  }

  return [...byFile.values()];
}

/** Pull the shell command text from a `shell_command` payload, all shapes. */
function shellCommandText(payload: HookPayload): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  };
  const ti = payload.tool_input as unknown;
  if (typeof ti === 'string') {
    push(ti);
  } else if (ti && typeof ti === 'object') {
    const c = (ti as Record<string, unknown>).command;
    if (typeof c === 'string') push(c);
    else if (Array.isArray(c))
      push(c.filter((x): x is string => typeof x === 'string').join(' '));
  }
  // Flat shapes: `arguments`/`input` may be the command, or a JSON object string
  // like `{"command":"…","timeout_ms":…}` (Codex's shell_command arguments).
  for (const raw of [payload.arguments, payload.input]) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    try {
      const o: unknown = JSON.parse(raw);
      const c =
        o && typeof o === 'object' ? (o as Record<string, unknown>).command : undefined;
      if (typeof c === 'string') {
        push(c);
        continue;
      }
    } catch {
      /* not JSON — fall through and treat the raw string as the command */
    }
    push(raw);
  }
  return out;
}

// Heuristic patterns that write a file in a raw shell command; each captures the
// path (quoted or bare) in group 1. Conservative by design — we only snapshot
// paths that resolve to a real file, and the hook's git fallback catches writes
// these miss (e.g. a path held in a shell variable like `$scratch`).
const SHELL_WRITE_RES: RegExp[] = [
  // PowerShell: Set-Content/Add-Content/Out-File/Tee-Object -LiteralPath|-Path|-FilePath <path>
  /(?:Set-Content|Add-Content|Out-File|Tee-Object)\b[^\n|;]*?\s-(?:LiteralPath|FilePath|Path)\s+("[^"]+"|'[^']+'|[^\s'"|;]+)/gi,
  // Shell redirect: `> path` / `>> path`.
  />>?\s*("[^"]+"|'[^']+'|[^\s'"|;&>]+)/g,
  // tee / tee -a <path>
  /\btee\b(?:\s+-a)?\s+("[^"]+"|'[^']+'|[^\s'"|;&]+)/g,
  // sed -i / perl -i over a final path token.
  /\b(?:sed|perl)\b[^\n]*?\s-i\b[^\n]*?\s("[^"]+"|'[^']+'|[^\s'"|;&]+)\s*$/gim,
];

function unquote(tok: string): string {
  if (
    (tok.startsWith('"') && tok.endsWith('"')) ||
    (tok.startsWith("'") && tok.endsWith("'"))
  ) {
    return tok.slice(1, -1);
  }
  return tok;
}

/**
 * Best-effort file path(s) a Codex `shell_command` wrote. Codex edits files via
 * raw shell when it doesn't use `apply_patch` (notably PowerShell `Set-Content`
 * on Windows), and those writes carry no structured file field. We parse the
 * common write patterns (see {@link SHELL_WRITE_RES}) plus an `apply_patch`
 * envelope run through the shell. Paths held in shell variables can't be
 * resolved here — the hook's git fallback covers those.
 */
export function extractShellCommandFiles(payload: HookPayload): string[] {
  const out: string[] = [];
  for (const cmd of shellCommandText(payload)) {
    // `apply_patch` invoked through the shell carries a full envelope.
    for (const m of cmd.matchAll(APPLY_PATCH_FILE_RE)) {
      const p = m[1]?.trim();
      if (p) out.push(normalizeHookPath(p, payload.cwd));
    }
    for (const re of SHELL_WRITE_RES) {
      for (const m of cmd.matchAll(re)) {
        const tok = m[1]?.trim();
        if (!tok) continue;
        const p = unquote(tok);
        // Skip unresolved shell variables (PowerShell `$x`, cmd `%x%`).
        if (!p || p.includes('$') || p.includes('%')) continue;
        out.push(normalizeHookPath(p, payload.cwd));
      }
    }
  }
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

// --- GitHub Copilot CLI payloads -------------------------------------------
// Copilot CLI's file-hook stdin shape differs from Claude's (verified against the
// installed CLI v1.0.64 and real session logs): `{ sessionId, cwd, prompt (on
// userPromptSubmitted), toolName, toolArgs }`. `toolArgs` arrives as a STRINGIFIED
// JSON object (e.g. `"{\"path\":\"…\",\"old_str\":\"…\",\"new_str\":\"…\"}"`), so
// callers must JSON-parse it. The edit tool is `edit` (`{path, old_str, new_str}`);
// `view` is a read (`{path}` only) — distinguished by the presence of an edit
// signal (`old_str`/`new_str`/`content`), NOT by the bare path, so a read is never
// mistaken for an edit even if the postToolUse matcher is absent.

/** The subset of a Copilot CLI hook payload Showtail reads. */
export interface CopilotCliHookPayload {
  sessionId?: string;
  cwd?: string;
  /** userPromptSubmitted: the prompt the student submitted. */
  prompt?: string;
  toolName?: string;
  /** postToolUse: the tool's arguments — a JSON STRING, or (defensively) an object. */
  toolArgs?: unknown;
}

const COPILOT_FILE_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file'] as const;

/** Coerce Copilot's `toolArgs` (a JSON string, or already an object) to a record. */
function copilotToolArgs(p: CopilotCliHookPayload): Record<string, unknown> | null {
  const a = p.toolArgs;
  if (a && typeof a === 'object' && !Array.isArray(a))
    return a as Record<string, unknown>;
  if (typeof a === 'string' && a.trim().length > 0) {
    try {
      const o: unknown = JSON.parse(a);
      if (o && typeof o === 'object' && !Array.isArray(o))
        return o as Record<string, unknown>;
    } catch {
      /* not JSON — nothing structured to read */
    }
  }
  return null;
}

/** True when the tool args carry an edit signal (so a read like `view` is excluded). */
function copilotIsEdit(args: Record<string, unknown>): boolean {
  return (
    typeof args.old_str === 'string' ||
    typeof args.new_str === 'string' ||
    typeof args.content === 'string'
  );
}

/** Copilot CLI's session id (the session-state directory name). */
export function extractCopilotCliSessionId(
  p: CopilotCliHookPayload | null,
): string | undefined {
  const id = p?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The submitted prompt from a Copilot CLI userPromptSubmitted payload. */
export function extractCopilotCliPrompt(p: CopilotCliHookPayload): string | undefined {
  const t = p.prompt;
  if (typeof t !== 'string') return undefined;
  const trimmed = t.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** File(s) a Copilot CLI `edit` (or create/write) touched, repo-relative. Reads are excluded. */
export function extractCopilotCliEditedFiles(p: CopilotCliHookPayload): string[] {
  const args = copilotToolArgs(p);
  if (!args || !copilotIsEdit(args)) return [];
  const out: string[] = [];
  for (const k of COPILOT_FILE_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) out.push(normalizeHookPath(v, p.cwd));
  }
  return [...new Set(out)];
}

/** AI-suggested code for a Copilot CLI edit: old_str→new_str, or a written file's content. */
export function extractCopilotCliSuggestedCode(
  p: CopilotCliHookPayload,
): string | undefined {
  const args = copilotToolArgs(p);
  if (!args) return undefined;
  if (typeof args.old_str === 'string' || typeof args.new_str === 'string') {
    const d = simpleDiff(args.old_str, args.new_str);
    return d || undefined;
  }
  if (typeof args.content === 'string' && args.content.length > 0) {
    return simpleDiff(undefined, args.content);
  }
  return undefined;
}
