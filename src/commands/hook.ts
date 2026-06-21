import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { resolveActiveAuthorForHook } from '../core/authors.ts';
import { readTranscriptFile } from '../core/claudeCode.ts';
import {
  importedSourceIds,
  logEvent,
  readSessionEvents,
  sweepIdleSessions,
} from '../core/events.ts';
import {
  extractApplyPatchFiles,
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  readHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import { redact } from '../core/redact.ts';
import { autoInitEnabled } from '../core/globalConfig.ts';
import {
  closeSession,
  currentSession,
  sessionForClaudeId,
  startSession,
} from '../core/sessions.ts';
import {
  findRoot,
  isEligibleAnchor,
  pathsForRoot,
  readConfig,
  readSessions,
  readState,
  resolveAnchor,
  setTurnForClaudeSession,
  turnForClaudeSession,
  updateState,
  type AuthorPaths,
} from '../core/storage.ts';
import { ensureInitialized } from './init.ts';
import type { Config, Tool } from '../types.ts';

export type HookEvent =
  | 'session-start'
  | 'user-prompt'
  | 'post-edit'
  | 'stop'
  | 'session-end';

/** Default minutes of inactivity before a session auto-closes. */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;

export interface HookOptions {
  cwd?: string;
  /** Which tool fired the hook (defaults to claude-code). Codex passes 'codex'. */
  tool?: Tool;
}

/** Don't snapshot Showtail/Claude/Codex's own bookkeeping files. */
export function isInternalPath(p: string): boolean {
  // .claude/worktrees/<name>/ holds isolated code checkouts (real work), so edits
  // there must be captured; only the tools' own metadata dirs are skipped.
  if (/(^|[\\/])\.claude[\\/]worktrees[\\/]/.test(p)) return false;
  return /(^|[\\/])\.(showtail|claude|codex)([\\/]|$)/.test(p);
}

/**
 * Handle one hook event (from Claude Code or Codex). This is intentionally
 * bulletproof: any problem (no project, malformed input, missing file, or no
 * resolvable student identity) results in a silent no-op with exit code 0, so a
 * student's session is never interrupted.
 */
export async function runHook(
  event: HookEvent,
  options: HookOptions = {},
): Promise<void> {
  try {
    const payload = await readHookPayload();
    const cwd = payload?.cwd ?? options.cwd ?? process.cwd();
    const tool: Tool = options.tool ?? 'claude-code';

    let root = findRoot(cwd);
    if (!root) {
      // Automatic tracking: silently start a trail on the first real activity in
      // an eligible project (git repo / dev folder), once the user has opted in
      // via `showtail setup`. Only a task start may create one — never a stray
      // edit/stop. `isEligibleAnchor` also refuses HOME, so a whole home dir is
      // never turned into one shared trail.
      if (event !== 'session-start' && event !== 'user-prompt') return;
      if (!autoInitEnabled()) return;
      const anchor = await resolveAnchor(cwd);
      if (!isEligibleAnchor(anchor)) return;
      await ensureInitialized(anchor);
      root = anchor;
    }
    const paths = pathsForRoot(root);
    if (!existsSync(paths.config)) return; // Not initialized.
    const config = readConfig(paths);

    // Resolve who is writing this trail. Cache-only / git-config at worst — never
    // prompts or hits the network, so the hook stays fast and non-blocking. If
    // identity can't be settled silently, no-op rather than guess.
    const author = await resolveActiveAuthorForHook(paths, { cwd });
    if (!author) return;

    // On any live capture, first close this author's sessions that have gone idle
    // (stamped at their last event), so a finished task's session doesn't linger
    // open. Tool-agnostic fallback to the SessionEnd hook below.
    if (event === 'user-prompt' || event === 'post-edit') {
      const idleMin = config.settings.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
      sweepIdleSessions(author, idleMin * 60_000, Date.now());
    }

    switch (event) {
      case 'session-start':
        return handleSessionStart(author, payload, tool);
      case 'user-prompt':
        return await handleUserPrompt(author, payload, tool);
      case 'post-edit':
        return await handlePostEdit(author, payload, tool, config);
      case 'stop':
        return await handleStop(author, payload, tool, config);
      case 'session-end':
        return handleSessionEnd(author, payload);
    }
  } catch {
    // Swallow everything — a hook must never break the session.
    return;
  }
}

function handleSessionStart(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
): void {
  // Bind this session to Claude's session_id when we have one, so a
  // resume/compact reuses the *same* trail instead of spawning a new session
  // each time. Without an id (older clients), fall back to the single current
  // session. Either way this becomes the CLI's "current" session.
  const claudeSessionId = extractSessionId(payload);
  const session = claudeSessionId
    ? sessionForClaudeId(author, claudeSessionId, { tool })
    : (currentSession(author) ?? startSession(author));
  updateState(author.shared, { currentSessionId: session.id });
  // SessionStart stdout is injected into Claude's context — keep it to one line.
  process.stdout.write(
    `Showtail is capturing this session's work trail (session ${session.id}). ` +
      `Your prompts and edits are captured automatically — just work as usual.\n`,
  );
}

/**
 * On SessionEnd (the tool's session truly ending — quit, clear, logout), close
 * the bound session deterministically rather than waiting for the idle sweep.
 * Keyed to the session that mirrors this tool session_id, else the global
 * current session. Stamps `endedAt` at the latest captured event (or now).
 */
function handleSessionEnd(author: AuthorPaths, payload: HookPayload | null): void {
  const claudeSessionId = extractSessionId(payload);
  const sessions = readSessions(author);
  const session = claudeSessionId
    ? sessions.find((s) => s.claudeSessionId === claudeSessionId && !s.endedAt)
    : sessions.find((s) => s.id === readState(author.shared).currentSessionId);
  if (!session) return;
  let lastTs = session.startedAt;
  for (const e of readSessionEvents(author, session.id)) {
    if (e.timestamp > lastTs) lastTs = e.timestamp;
  }
  const at = new Date().toISOString();
  closeSession(author, session.id, lastTs > at ? lastTs : at);
}

async function handleUserPrompt(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
): Promise<void> {
  if (!payload) return;
  const text = extractPrompt(payload);
  if (!text) return;
  // Log the prompt into the session that owns this Claude session_id (creating
  // it if the session-start hook never fired); without an id, the current
  // session is used (unchanged behavior).
  const claudeSessionId = extractSessionId(payload);
  const sessionId = claudeSessionId
    ? sessionForClaudeId(author, claudeSessionId, { tool }).id
    : undefined;
  const { event } = await logEvent(author, { type: 'prompt', text, tool, sessionId });
  // Open a new "turn": edits and AI output that follow link back to this prompt.
  // Track it per Claude session so interleaved sessions don't share one turn.
  if (claudeSessionId) {
    updateState(author.shared, { currentSessionId: sessionId });
    setTurnForClaudeSession(author.shared, claudeSessionId, event.id);
  } else {
    updateState(author.shared, { currentPromptId: event.id });
  }
  // Print nothing: this path must not add anything to the session's context.
}

async function handlePostEdit(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
): Promise<void> {
  if (!payload) return;
  // Attach the edit to the open turn of *its* Claude session when we can tell
  // which one fired; otherwise the global current turn (unchanged behavior).
  const claudeSessionId = extractSessionId(payload);
  const turnId =
    (claudeSessionId
      ? turnForClaudeSession(author.shared, claudeSessionId)
      : undefined) ??
    readState(author.shared).currentPromptId ??
    undefined;
  // Capture the AI-suggested code (unless code capture is turned off).
  const diff =
    config.settings.captureCode === false ? undefined : extractSuggestedCode(payload);
  // Codex edits via apply_patch; Claude via Edit/Write/MultiEdit.
  const files =
    tool === 'codex' ? extractApplyPatchFiles(payload) : extractEditedFiles(payload);
  for (const file of files) {
    if (isInternalPath(file)) continue;
    try {
      await addArtifact(author, { filePath: file, tool, turnId, diff });
    } catch {
      // File may have been moved/deleted by now — skip it quietly.
    }
  }
}

/**
 * On Stop, reconcile the trail against Claude Code's transcript — the complete,
 * truthful record of the session. We walk the transcript in order and attribute
 * each assistant reply to the prompt it actually followed, so every reply lands
 * under the right turn no matter how many prompts happened between Stops. Any
 * prompt the student typed but that the live `user-prompt` hook missed is
 * back-filled here (never dropped); the `Stop` and `user-prompt` hooks are
 * separate, so a prompt can be absent even though the student really sent it.
 *
 * Replies are attributed to the session that mirrors *this transcript's own*
 * Claude `session_id` — never a single global "current" session, which under
 * concurrent/resumed sessions points at the wrong one and silently drops
 * legitimate replies.
 *
 * The only thing excluded is content from *before this session started watching*
 * (pre-trail backlog from a resumed transcript), which must not be dumped onto a
 * later turn. A transcript prompt counts as in-window if it matches a prompt we
 * already logged this session (checked first, so it can never be mistaken for
 * backlog), or it carries a timestamp at/after the session start. Best-effort:
 * no transcript (e.g. Codex) means a silent no-op.
 */
async function handleStop(
  author: AuthorPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
): Promise<void> {
  const transcriptPath = payload?.transcript_path;
  if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return;
  // AI text replies obey `captureAiOutput`; prompts and decisions are the
  // student's own work and are captured regardless.
  const captureAi = config.settings.captureAiOutput !== false;

  let transcript;
  try {
    transcript = readTranscriptFile(transcriptPath, author.shared.root);
  } catch {
    return; // Unknown/unsupported transcript format — nothing to capture.
  }

  // Resolve the session this transcript belongs to. The transcript's own
  // session_id is the source of truth; fall back to the payload's, then to the
  // global current session (older clients that send no id).
  const claudeSessionId = transcript.sessionId ?? extractSessionId(payload);
  let session;
  if (claudeSessionId) {
    session = sessionForClaudeId(author, claudeSessionId, { tool });
  } else {
    const currentId = readState(author.shared).currentSessionId;
    session = currentId
      ? readSessions(author).find((s) => s.id === currentId)
      : undefined;
  }
  if (!session) return; // No session to attribute to.
  const sessionId = session.id;
  const startedAt = session.startedAt;

  // Prompts already logged this session, indexed two ways: by transcript uuid
  // (a prompt we back-filled on an earlier Stop) and by stored text as a FIFO
  // (a prompt logged live), so duplicate prompt texts line up in order.
  const bySourceId = new Map<string, string>();
  const byText = new Map<string, string[]>();
  for (const p of readSessionEvents(author, sessionId)) {
    if (p.type !== 'prompt') continue;
    if (p.sourceId) bySourceId.set(p.sourceId, p.id);
    const queue = byText.get(p.text) ?? [];
    queue.push(p.id);
    byText.set(p.text, queue);
  }

  const seen = importedSourceIds(author);
  const redactCfg = config.settings.redact;
  let currentTurn: string | undefined; // The prompt id replies attach to.

  for (const msg of transcript.messages) {
    if (msg.role === 'user') {
      // Match an already-logged prompt FIRST — by uuid, then by redacted text
      // (prompts are stored redacted, so redact the transcript text to compare).
      // A prompt we already logged this session is in-window by definition and
      // must never be reclassified as backlog, even if its transcript timestamp
      // predates this session's start.
      let id = msg.sourceId ? bySourceId.get(msg.sourceId) : undefined;
      if (!id) {
        const queue = byText.get(redact(msg.text, redactCfg).text);
        if (queue && queue.length > 0) id = queue.shift();
      }
      if (!id) {
        // Unmatched. Back-fill only when a timestamp proves it's in-window
        // (at/after this session's start); a backlog or timestamp-less prompt is
        // skipped so a resumed transcript isn't dumped onto a later turn.
        if (!msg.timestamp || msg.timestamp < startedAt) {
          currentTurn = undefined;
          continue;
        }
        const { event } = await logEvent(author, {
          type: 'prompt',
          text: msg.text,
          tool,
          timestamp: msg.timestamp,
          sourceId: msg.sourceId,
          sessionId,
        });
        id = event.id;
        if (msg.sourceId) bySourceId.set(msg.sourceId, id);
      }
      currentTurn = id;
    } else if (msg.role === 'assistant') {
      // A reply only belongs to the trail if it follows an in-window prompt.
      if (!captureAi || !currentTurn || seen.has(msg.sourceId)) continue;
      await logEvent(author, {
        type: 'ai_output',
        text: msg.text,
        tool,
        // Stamp with the transcript message time (not now, the Stop time), so the
        // reply orders chronologically against edits in the report.
        timestamp: msg.timestamp,
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId,
      });
      seen.add(msg.sourceId);
    } else if (msg.role === 'decision') {
      // The student chose between options the AI offered — their own work, so
      // it's captured even when AI-output capture is off. Attach to the open turn.
      if (!currentTurn || seen.has(msg.sourceId)) continue;
      await logEvent(author, {
        type: 'decision',
        text: msg.text,
        tool,
        timestamp: msg.timestamp, // message time, so it interleaves chronologically
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId,
      });
      seen.add(msg.sourceId);
    }
    // `edit` messages are ignored — the post-edit hook already records those.
  }
}
