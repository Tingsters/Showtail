/**
 * Import an existing Codex rollout into a Showtail trail.
 *
 * Finding and parsing rollouts lives in `@showtail/agent-traces`; this module adds
 * the trail-specific parts: import-picker summaries and journal writes.
 */

import { readFileSync } from 'node:fs';
import { importEditArtifact, importedArtifactSourceIds } from './artifacts.ts';
import { importedPromptIds, importedSourceIds } from './events.ts';
import {
  conversationEventEnabled,
  importedConversationSourceIds,
  logConversationEvent,
} from './conversationEvents.ts';
import { readConfig, type AuthorPaths } from './storage.ts';
import {
  findProjectRollouts,
  parseCodexTranscript,
  readCodexSession,
  readRolloutFile,
  rolloutFormatWarning,
  unreadableRolloutItems,
  type CodexMessage,
  type CodexRolloutSummary,
  type CodexTranscript,
} from '@showtail/agent-traces/codex/transcript';

export * from '@showtail/agent-traces/codex/transcript';

// --- Summaries (for the import picker) -------------------------------------

/**
 * Summarize every rollout for `author.shared.root`, newest first, so the picker
 * can show counts, a span, and first/last prompt. Each rollout is parsed once; a
 * rollout that fails to parse still appears (counts zeroed) so `--file` can reach
 * it. `importState` is computed against the trail's existing source ids.
 */
export function summarizeRollouts(author: AuthorPaths): CodexRolloutSummary[] {
  const seen = importedSourceIds(author);
  const seenArtifacts = importedArtifactSourceIds(author);
  const root = author.shared.root;
  // An edit imports as one diff artifact per file (`<sourceId>#<file>`); it counts
  // as imported once every touched file is on disk. Everything else dedupes by its
  // event source id.
  const isImported = (m: CodexMessage): boolean => {
    if (m.role === 'edit') {
      const files = m.files ?? [];
      return (
        files.length > 0 && files.every((f) => seenArtifacts.has(`${m.sourceId}#${f}`))
      );
    }
    return seen.has(m.sourceId);
  };
  return findProjectRollouts(root).map((info) => {
    const summary: CodexRolloutSummary = {
      info,
      promptCount: 0,
      editCount: 0,
      firstPrompt: '',
      lastPrompt: '',
      importState: 'none',
    };

    let parsed: CodexTranscript;
    try {
      const content = readFileSync(info.path, 'utf8');
      parsed = parseCodexTranscript(content, root);
      // Tripwire: a populated rollout the file reader returned nothing for is a
      // format change, not an empty session — say so instead of listing "0 prompts".
      if (rolloutFormatWarning(content, parsed)) {
        summary.unreadableItems = unreadableRolloutItems(content);
      }
    } catch {
      return summary;
    }

    const prompts = parsed.messages.filter((m) => m.role === 'user');
    summary.promptCount = prompts.length;
    summary.editCount = parsed.messages.filter((m) => m.role === 'edit').length;
    summary.firstPrompt = prompts[0]?.text ?? '';
    summary.lastPrompt = prompts[prompts.length - 1]?.text ?? '';

    let importedCount = 0;
    for (const m of parsed.messages) {
      if (isImported(m)) importedCount += 1;
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

export interface CodexImportOptions {
  /** Also log Codex's text replies as `ai_output` events (default: prompts only). */
  withResponses?: boolean;
  sessionId?: string;
  /** Tag every imported event with this batch id so the import can be undone. */
  batchId?: string;
}

export interface CodexImportResult {
  title: string;
  prompts: number;
  responses: number;
  edits: number;
  plans: number;
  decisions: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Import a parsed rollout into the trail. User prompts become `prompt` events,
 * assistant replies become `ai_output` (only with `withResponses`), decisions and
 * plans become `decision`/`plan` events, and each AI edit becomes a back-dated
 * `artifact` carrying its captured apply_patch diff (so it renders as an expandable
 * code change, just like a live snapshot — but with no file hash, since a past
 * file's content can't be recovered). Every event is tagged `tool: codex` and
 * `imported`, stamped with the original time, and deduped by `sourceId` so
 * re-importing adds nothing.
 *
 * Imports the {@link logEvent} machinery lazily here (same module as Claude's
 * importer) to keep the parser surface free of trail-write side effects.
 */
export async function importCodexTranscript(
  author: AuthorPaths,
  transcript: CodexTranscript,
  options: CodexImportOptions = {},
): Promise<CodexImportResult> {
  const { logEvent } = await import('./events.ts');
  const seen = importedSourceIds(author);
  const seenArtifacts = importedArtifactSourceIds(author);
  const result: CodexImportResult = {
    title: transcript.title,
    prompts: 0,
    responses: 0,
    edits: 0,
    plans: 0,
    decisions: 0,
    skipped: 0,
  };

  const stampSpan = (ts: string | undefined): void => {
    if (!ts) return;
    if (!result.first || ts < result.first) result.first = ts;
    if (!result.last || ts > result.last) result.last = ts;
  };

  // A user prompt opens a turn; the reply/edits that follow link back via this id.
  let currentTurnId: string | undefined;
  const promptBySourceId = importedPromptIds(author);

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && !options.withResponses) continue;

    // Edits become back-dated diff artifacts (one per touched file), not events.
    if (msg.role === 'edit') {
      for (const e of msg.edits ?? []) {
        const sourceId = `${msg.sourceId}#${e.file}`;
        if (seenArtifacts.has(sourceId)) {
          result.skipped += 1;
          continue;
        }
        // `e.diff` is the clean per-file diff (a deletion carries its removed
        // lines); importEditArtifact skips an empty diff on its own.
        const wrote = importEditArtifact(author, {
          path: e.file,
          diff: e.diff ?? '',
          tool: 'codex',
          turnId: currentTurnId,
          timestamp: msg.timestamp,
          sessionId: options.sessionId,
          sourceId,
          batchId: options.batchId,
        });
        if (wrote) {
          seenArtifacts.add(sourceId);
          result.edits += 1;
          stampSpan(msg.timestamp);
        }
      }
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
            : 'plan';

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'codex',
      model: msg.model,
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      // Codex plans carry no approval tag (headless — never approved/revised).
      tags: ['imported'],
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') {
      currentTurnId = event.id;
      promptBySourceId.set(msg.sourceId, event.id);
    }

    if (msg.role === 'user') result.prompts += 1;
    else if (msg.role === 'assistant') result.responses += 1;
    else if (msg.role === 'plan') result.plans += 1;
    else if (msg.role === 'decision') result.decisions += 1;

    stampSpan(msg.timestamp);
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
      tool: 'codex',
      turnId: conversationTurnId,
      sessionId: options.sessionId,
      batchId: options.batchId,
    });
    seenConversation.add(sourceId);
  }

  return result;
}
