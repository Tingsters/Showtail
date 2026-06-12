import { existsSync } from 'node:fs';
import { addArtifact } from '../core/artifacts.ts';
import { logEvent } from '../core/events.ts';
import {
  extractEditedFiles,
  extractPrompt,
  readHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import { currentSession, startSession } from '../core/sessions.ts';
import { findRoot, pathsForRoot, type ShowtailPaths } from '../core/storage.ts';

export type HookEvent = 'session-start' | 'user-prompt' | 'post-edit' | 'stop';

export interface HookOptions {
  cwd?: string;
}

/** Don't snapshot Showtail/Claude's own bookkeeping files. */
function isInternalPath(p: string): boolean {
  return /(^|[\\/])\.(showtail|claude)([\\/]|$)/.test(p);
}

/**
 * Handle one Claude Code hook event. This is intentionally bulletproof: any
 * problem (no project, malformed input, missing file) results in a silent
 * no-op with exit code 0, so a student's Claude session is never interrupted.
 */
export async function runHook(
  event: HookEvent,
  options: HookOptions = {},
): Promise<void> {
  try {
    const payload = await readHookPayload();
    const cwd = payload?.cwd ?? options.cwd ?? process.cwd();

    const root = findRoot(cwd);
    if (!root) return; // Not a Showtail project — nothing to do.
    const paths = pathsForRoot(root);
    if (!existsSync(paths.config)) return; // Not initialized.

    switch (event) {
      case 'session-start':
        return handleSessionStart(paths);
      case 'user-prompt':
        return await handleUserPrompt(paths, payload);
      case 'post-edit':
        return await handlePostEdit(paths, payload);
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
): Promise<void> {
  if (!payload) return;
  const text = extractPrompt(payload);
  if (!text) return;
  await logEvent(paths, { type: 'prompt', text, tool: 'claude-code' });
  // Print nothing: this path must not add anything to Claude's context.
}

async function handlePostEdit(
  paths: ShowtailPaths,
  payload: HookPayload | null,
): Promise<void> {
  if (!payload) return;
  for (const file of extractEditedFiles(payload)) {
    if (isInternalPath(file)) continue;
    try {
      await addArtifact(paths, { filePath: file, tool: 'claude-code' });
    } catch {
      // File may have been moved/deleted by now — skip it quietly.
    }
  }
}
