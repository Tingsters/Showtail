/**
 * Import an existing Claude Code session transcript into a Showtail trail.
 *
 * Finding and parsing transcripts lives in `@showtail/agent-traces`; this module
 * adds the trail-specific parts: summarizing against what's already imported,
 * and writing imported messages into the journal.
 */

import { readFileSync } from 'node:fs';
import { importedPromptIds, importedSourceIds, logEvent } from './events.ts';
import {
  conversationEventEnabled,
  importedConversationSourceIds,
  logConversationEvent,
} from './conversationEvents.ts';
import { readConfig, type AuthorPaths } from './storage.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from './plans.ts';
import {
  findProjectTranscripts,
  parseClaudeTranscript,
  readTranscriptFile,
  type ClaudeTranscript,
  type TranscriptSummary,
} from '@showtail/agent-traces/claude/transcript';

export * from '@showtail/agent-traces/claude/transcript';

/**
 * Summarize every transcript for `paths.root`, newest first, so the picker can
 * show counts, a time span, and first/last prompt for each. Each transcript is
 * parsed once; a transcript that fails to parse still appears (counts zeroed)
 * so it can be tried via `--file`. `importState` is computed against the source
 * ids already in the trail so the picker can flag already-imported sessions.
 */
export function summarizeTranscripts(author: AuthorPaths): TranscriptSummary[] {
  const seen = importedSourceIds(author);
  const root = author.shared.root;
  return findProjectTranscripts(root).map((info) => {
    const summary: TranscriptSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: ClaudeTranscript;
    try {
      parsed = parseClaudeTranscript(readFileSync(info.path, 'utf8'), root);
    } catch {
      return summary; // Couldn't parse — list it bare so --file can still reach it.
    }

    const prompts = parsed.messages.filter((m) => m.role === 'user');
    summary.promptCount = prompts.length;
    summary.editCount = parsed.messages.filter((m) => m.role === 'edit').length;
    summary.firstPrompt = prompts[0]?.text ?? '';
    summary.lastPrompt = prompts[prompts.length - 1]?.text ?? '';

    let importedCount = 0;
    for (const m of parsed.messages) {
      if (seen.has(m.sourceId)) importedCount += 1;
      if (m.timestamp) {
        if (!summary.first || m.timestamp < summary.first) summary.first = m.timestamp;
        if (!summary.last || m.timestamp > summary.last) summary.last = m.timestamp;
      }
    }
    if (parsed.messages.length > 0) {
      summary.importState =
        importedCount === 0
          ? 'none'
          : importedCount === parsed.messages.length
            ? 'full'
            : 'partial';
    }

    return summary;
  });
}

// --- Importing -------------------------------------------------------------

export interface ClaudeImportOptions {
  /** Also log Claude's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface ClaudeImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  decisions: number;
  plans: number;
  toolCalls: number;
  recaps: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed transcript into the trail. User prompts become `prompt`
 * events, assistant replies become `ai_output` (only with `withResponses`),
 * each AI edit becomes a back-dated `artifact` event noting the file (not a hash
 * snapshot, since a past file's hash can't be recovered), and each AskUserQuestion
 * choice becomes a `decision` event (always imported — it's the student's own
 * work). Every event is tagged `tool: claude-code` and `imported`, stamped with
 * the original time, and deduped by `sourceId` so re-importing adds nothing.
 */
export async function importClaudeTranscript(
  author: AuthorPaths,
  transcript: ClaudeTranscript,
  options: ClaudeImportOptions = {},
): Promise<ClaudeImportResult> {
  const seen = importedSourceIds(author);
  const result: ClaudeImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    decisions: 0,
    plans: 0,
    toolCalls: 0,
    recaps: 0,
    skipped: 0,
  };

  // A user prompt opens a turn; the assistant reply and edits that follow it
  // link back via this id, so the report groups the imported exchange.
  let currentTurnId: string | undefined;
  const promptBySourceId = importedPromptIds(author);

  for (const msg of transcript.messages) {
    // Tool calls are Claude's own actions during the exchange, same as its text
    // replies — gated by the same flag. Recaps (duration/tokens/branch) are the
    // turn's own stats, not AI-authored content, so (like decisions/plans) they
    // are always imported.
    if (
      (msg.role === 'assistant' || msg.role === 'tool_call') &&
      !options.withResponses
    ) {
      continue;
    }
    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const type =
      msg.role === 'user'
        ? 'prompt'
        : msg.role === 'assistant'
          ? 'ai_output'
          : msg.role === 'decision'
            ? 'decision'
            : msg.role === 'plan'
              ? 'plan'
              : msg.role === 'tool_call'
                ? 'tool_call'
                : msg.role === 'recap'
                  ? 'recap'
                  : 'artifact';

    // Plans carry their approval status as a tag (in addition to `imported`).
    const tags =
      msg.role === 'plan'
        ? ['imported', msg.approved ? PLAN_APPROVED_TAG : PLAN_REVISED_TAG]
        : ['imported'];

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'claude-code',
      model: msg.model,
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      files: msg.files,
      tags,
      turnId: msg.role === 'user' ? undefined : currentTurnId,
      toolName: msg.toolName,
      isError: msg.isError,
      durationMs: msg.durationMs,
      gitBranch: msg.gitBranch,
      inputTokens: msg.inputTokens,
      outputTokens: msg.outputTokens,
      cacheReadTokens: msg.cacheReadTokens,
      cacheCreationTokens: msg.cacheCreationTokens,
    });
    if (msg.role === 'user') {
      currentTurnId = event.id;
      promptBySourceId.set(msg.sourceId, event.id);
    }

    if (msg.role === 'user') result.prompts += 1;
    else if (msg.role === 'assistant') result.responses += 1;
    else if (msg.role === 'decision') result.decisions += 1;
    else if (msg.role === 'plan') result.plans += 1;
    else if (msg.role === 'tool_call') result.toolCalls += 1;
    else if (msg.role === 'recap') result.recaps += 1;
    else result.edits += 1;

    if (msg.timestamp) {
      if (!result.first || msg.timestamp < result.first) result.first = msg.timestamp;
      if (!result.last || msg.timestamp > result.last) result.last = msg.timestamp;
    }
  }

  const seenConversation = importedConversationSourceIds(author);
  const toolNames = new Map(
    transcript.events.flatMap((event) =>
      event.type === 'tool_use' && event.toolUseId && event.toolName
        ? [[event.toolUseId, event.toolName] as const]
        : [],
    ),
  );
  const settings = readConfig(author.shared).settings;
  let conversationTurnId: string | undefined;
  for (const raw of transcript.events) {
    if (raw.type === 'user_text') {
      conversationTurnId = promptBySourceId.get(raw.sourceId);
    }
    if (!conversationTurnId) continue;
    if (
      !conversationEventEnabled(raw, toolNames, settings, {
        includeResponses: options.withResponses === true,
      })
    ) {
      continue;
    }
    const sourceId = `conversation:${raw.sourceId}`;
    if (seenConversation.has(sourceId)) continue;
    logConversationEvent(author, {
      event: { ...raw, sourceId },
      tool: 'claude-code',
      turnId: conversationTurnId,
      sessionId: options.sessionId,
      batchId: options.batchId,
    });
    seenConversation.add(sourceId);
  }

  return result;
}
