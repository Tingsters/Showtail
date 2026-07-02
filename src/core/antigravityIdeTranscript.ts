/**
 * Discover Google Antigravity *IDE* session transcripts.
 *
 * The IDE persists the same per-conversation "brain" JSONL the Antigravity CLI
 * does, only under a different product dir: `~/.gemini/antigravity-ide/brain/
 * <conversationId>/.system_generated/logs/transcript.jsonl` (the CLI uses
 * `~/.gemini/antigravity-cli/brain/...`). The line vocabulary is identical
 * (USER_INPUT / PLANNER_RESPONSE / CODE_ACTION / …), so this module reuses the
 * CLI reader's parser and brain-scan wholesale and only swaps the brain root.
 */
import { join } from 'node:path';
import {
  findTranscriptsUnderBrain,
  geminiHome,
  readAntigravityCliTranscript,
  type AntigravityCliTranscriptInfo,
} from './antigravityCliTranscript.ts';
import type { HookTranscript } from '../plugins/types.ts';

/** A transcript file found on disk for an Antigravity IDE conversation. */
export type AntigravityIdeTranscriptInfo = AntigravityCliTranscriptInfo;

/** The dir the Antigravity IDE stores per-conversation brains under. */
export function antigravityIdeBrainDir(): string {
  return join(geminiHome(), 'antigravity-ide', 'brain');
}

/** Every Antigravity IDE transcript on disk, newest first. */
export function findAntigravityIdeTranscripts(): AntigravityIdeTranscriptInfo[] {
  return findTranscriptsUnderBrain(antigravityIdeBrainDir());
}

/**
 * Locate the transcript for a Stop payload: prefer the conversation whose id
 * matches the payload's session id; otherwise the most recently modified
 * transcript (the just-stopped session). Returns null when nothing's on disk.
 */
export function locateAntigravityIdeTranscript(
  sessionId: string | undefined,
): AntigravityIdeTranscriptInfo | null {
  const all = findAntigravityIdeTranscripts();
  if (all.length === 0) return null;
  if (sessionId) {
    const byId = all.find((t) => t.sessionId === sessionId);
    if (byId) return byId;
  }
  return all[0]!; // newest first
}

/** Read and parse an Antigravity IDE transcript (delegates to the CLI parser). */
export function readAntigravityIdeTranscript(
  info: AntigravityIdeTranscriptInfo,
  root: string,
): HookTranscript {
  return readAntigravityCliTranscript(info, root);
}
