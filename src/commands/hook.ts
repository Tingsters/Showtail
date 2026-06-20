import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { readTranscriptFile } from '../core/claudeCode.ts';
import { importedSourceIds, logEvent, readSessionEvents } from '../core/events.ts';
import {
  extractApplyPatchFiles,
  extractEditedFiles,
  extractPrompt,
  extractSuggestedCode,
  readHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import { redact } from '../core/redact.ts';
import { currentSession, startSession } from '../core/sessions.ts';
import {
  findRoot,
  pathsForRoot,
  readConfig,
  readSessions,
  readState,
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
        return handleSessionStart(paths);
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

function handleSessionStart(paths: ShowtailPaths): void {
  const session = currentSession(paths) ?? startSession(paths);
  // SessionStart stdout is injected into Claude's context — keep it to one line.
  process.stdout.write(
    `Showtail is capturing this session's work trail (session ${session.id}). ` +
      `Your prompts and edits are captured automatically — just work as usual.\n`,
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
  const { event } = await logEvent(paths, { type: 'prompt', text, tool });
  // Open a new "turn": edits and AI output that follow link back to this prompt.
  updateState(paths, { currentPromptId: event.id });
  // Print nothing: this path must not add anything to the session's context.
}

async function handlePostEdit(
  paths: ShowtailPaths,
  payload: HookPayload | null,
  tool: Tool,
  config: Config,
): Promise<void> {
  if (!payload) return;
  const turnId = readState(paths).currentPromptId ?? undefined;
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
 * The only thing excluded is content from *before this session started watching*
 * (pre-trail backlog from a resumed transcript), which must not be dumped onto a
 * later turn. A transcript prompt counts as in-window if it matches a prompt we
 * already logged this session, or it carries a timestamp at/after the session
 * start. Best-effort: no transcript (e.g. Codex) means a silent no-op.
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

  const sessionId = readState(paths).currentSessionId;
  if (!sessionId) return; // No active session to attribute to.
  const session = readSessions(paths).find((s) => s.id === sessionId);
  if (!session) return;
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
      // Clearly pre-trail backlog: a timestamp before this session began.
      if (msg.timestamp && msg.timestamp < startedAt) {
        currentTurn = undefined;
        continue;
      }
      // Match an already-logged prompt: by uuid first, then by redacted text
      // (prompts are stored redacted, so redact the transcript text to compare).
      let id = msg.sourceId ? bySourceId.get(msg.sourceId) : undefined;
      if (!id) {
        const queue = byText.get(redact(msg.text, redactCfg).text);
        if (queue && queue.length > 0) id = queue.shift();
      }
      if (!id) {
        // Unmatched. Back-fill only when a timestamp proves it's in-window; a
        // timestamp-less, unmatched prompt is treated as backlog (don't dump).
        if (!msg.timestamp) {
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
