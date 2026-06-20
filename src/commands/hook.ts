import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { readTranscriptFile } from '../core/claudeCode.ts';
import { importedSourceIds, logEvent, readSessionEvents } from '../core/events.ts';
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
import { currentSession, sessionForClaudeId, startSession } from '../core/sessions.ts';
import {
  findRoot,
  pathsForRoot,
  readConfig,
  readSessions,
  readState,
  setTurnForClaudeSession,
  turnForClaudeSession,
  updateState,
  type ShowtailPaths,
} from '../core/storage.ts';
import type { Config, Tool } from '../types.ts';

export type HookEvent = 'session-start' | 'user-prompt' | 'post-edit' | 'stop';

export interface HookOptions {
  cwd?: string;
  /** Which tool fired the hook (defaults to claude-code). Codex passes 'codex'. */
  tool?: Tool;
}

/** Don't snapshot Showtail/Claude/Codex's own bookkeeping files. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|claude|codex)([\\/]|$)/.test(p);
}

/**
 * Handle one hook event (from Claude Code or Codex). This is intentionally
 * bulletproof: any problem (no project, malformed input, missing file) results
 * in a silent no-op with exit code 0, so a student's session is never
 * interrupted.
 */
export async function runHook(
  event: HookEvent,
  options: HookOptions = {},
): Promise<void> {
  try {
    const payload = await readHookPayload();
    const cwd = payload?.cwd ?? options.cwd ?? process.cwd();
    const tool: Tool = options.tool ?? 'claude-code';

    const root = findRoot(cwd);
    if (!root) return; // Not a Showtail project — nothing to do.
    const paths = pathsForRoot(root);
    if (!existsSync(paths.config)) return; // Not initialized.
    const config = readConfig(paths);

    switch (event) {
      case 'session-start':
        return handleSessionStart(paths, payload, tool);
      case 'user-prompt':
        return await handleUserPrompt(paths, payload, tool);
      case 'post-edit':
        return await handlePostEdit(paths, payload, tool, config);
      case 'stop':
        return await handleStop(paths, payload, tool, config);
    }
  } catch {
    // Swallow everything — a hook must never break the session.
    return;
  }
}

function handleSessionStart(
  paths: ShowtailPaths,
  payload: HookPayload | null,
  tool: Tool,
): void {
  // Bind this Showtail session to Claude's session_id when we have one, so a
  // resume/compact reuses the *same* trail instead of spawning a new session
  // each time. Without an id (older clients), fall back to the single current
  // session. Either way this becomes the CLI's "current" session.
  const claudeSessionId = extractSessionId(payload);
  const session = claudeSessionId
    ? sessionForClaudeId(paths, claudeSessionId, { tool })
    : (currentSession(paths) ?? startSession(paths));
  updateState(paths, { currentSessionId: session.id });
  // SessionStart stdout is injected into Claude's context — keep it to one line.
  process.stdout.write(
    `Showtail is capturing this session's work trail (session ${session.id}). ` +
      `Log decisions and reflections as you go; prompts and edits are captured automatically.\n`,
  );
}

async function handleUserPrompt(
  paths: ShowtailPaths,
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
    ? sessionForClaudeId(paths, claudeSessionId, { tool }).id
    : undefined;
  const { event } = await logEvent(paths, { type: 'prompt', text, tool, sessionId });
  // Open a new "turn": edits and AI output that follow link back to this prompt.
  // Track it per Claude session so interleaved sessions don't share one turn.
  if (claudeSessionId) {
    updateState(paths, { currentSessionId: sessionId });
    setTurnForClaudeSession(paths, claudeSessionId, event.id);
  } else {
    updateState(paths, { currentPromptId: event.id });
  }
  // Print nothing: this path must not add anything to the session's context.
}

async function handlePostEdit(
  paths: ShowtailPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
): Promise<void> {
  if (!payload) return;
  // Attach the edit to the open turn of *its* Claude session when we can tell
  // which one fired; otherwise the global current turn (unchanged behavior).
  const claudeSessionId = extractSessionId(payload);
  const turnId =
    (claudeSessionId ? turnForClaudeSession(paths, claudeSessionId) : undefined) ??
    readState(paths).currentPromptId ??
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
      await addArtifact(paths, { filePath: file, tool, turnId, diff });
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
 * Replies are attributed to the Showtail session that mirrors *this transcript's
 * own* Claude `session_id` — never a single global "current" session, which
 * under concurrent/resumed sessions points at the wrong one and silently drops
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
  paths: ShowtailPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
): Promise<void> {
  if (config.settings.captureAiOutput === false) return;
  const transcriptPath = payload?.transcript_path;
  if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return;

  let transcript;
  try {
    transcript = readTranscriptFile(transcriptPath, paths.root);
  } catch {
    return; // Unknown/unsupported transcript format — nothing to capture.
  }

  // Resolve the session this transcript belongs to. The transcript's own
  // session_id is the source of truth; fall back to the payload's, then to the
  // global current session (older clients that send no id).
  const claudeSessionId = transcript.sessionId ?? extractSessionId(payload);
  let session;
  if (claudeSessionId) {
    session = sessionForClaudeId(paths, claudeSessionId, { tool });
  } else {
    const currentId = readState(paths).currentSessionId;
    session = currentId ? readSessions(paths).find((s) => s.id === currentId) : undefined;
  }
  if (!session) return; // No session to attribute to.
  const sessionId = session.id;
  const startedAt = session.startedAt;

  // Prompts already logged this session, indexed two ways: by transcript uuid
  // (a prompt we back-filled on an earlier Stop) and by stored text as a FIFO
  // (a prompt logged live), so duplicate prompt texts line up in order.
  const bySourceId = new Map<string, string>();
  const byText = new Map<string, string[]>();
  for (const p of readSessionEvents(paths, sessionId)) {
    if (p.type !== 'prompt') continue;
    if (p.sourceId) bySourceId.set(p.sourceId, p.id);
    const queue = byText.get(p.text) ?? [];
    queue.push(p.id);
    byText.set(p.text, queue);
  }

  const seen = importedSourceIds(paths);
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
        const { event } = await logEvent(paths, {
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
      if (!currentTurn || seen.has(msg.sourceId)) continue;
      await logEvent(paths, {
        type: 'ai_output',
        text: msg.text,
        tool,
        turnId: currentTurn,
        sourceId: msg.sourceId,
        sessionId,
      });
      seen.add(msg.sourceId);
    }
    // `edit` messages are ignored — the post-edit hook already records those.
  }
}
