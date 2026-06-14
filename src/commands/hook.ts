import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { logEvent } from '../core/events.ts';
import {
  extractApplyPatchFiles,
  extractEditedFiles,
  extractPrompt,
  readHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import { currentSession, startSession } from '../core/sessions.ts';
import { findRoot, pathsForRoot, type ShowtailPaths } from '../core/storage.ts';
import type { Tool } from '../types.ts';

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

    switch (event) {
      case 'session-start':
        return handleSessionStart(paths);
      case 'user-prompt':
        return await handleUserPrompt(paths, payload, tool);
      case 'post-edit':
        return await handlePostEdit(paths, payload, tool);
      case 'stop':
        return; // Reserved for a future, opt-in reflection nudge. No-op for now.
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
  await logEvent(paths, { type: 'prompt', text, tool });
  // Print nothing: this path must not add anything to the session's context.
}

async function handlePostEdit(
  paths: ShowtailPaths,
  payload: HookPayload | null,
  tool: Tool,
): Promise<void> {
  if (!payload) return;
  // Codex edits via apply_patch; Claude via Edit/Write/MultiEdit.
  const files =
    tool === 'codex' ? extractApplyPatchFiles(payload) : extractEditedFiles(payload);
  for (const file of files) {
    if (isInternalPath(file)) continue;
    try {
      await addArtifact(paths, { filePath: file, tool });
    } catch {
      // File may have been moved/deleted by now — skip it quietly.
    }
  }
}
