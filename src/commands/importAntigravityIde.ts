/**
 * `showtail import antigravity-ide` — back-fill a trail from the Antigravity IDE's
 * on-disk conversation transcript:
 *   ~/.gemini/antigravity-ide/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * The IDE's lifecycle hooks proved unreliable (only `PostToolUse` fires, no
 * `Stop`/`PreInvocation`, no stable session id), so live prompt/reply capture
 * can't be trusted. The transcript IS the complete, truthful record, so we import
 * it: prompts (`USER_INPUT`), replies (`PLANNER_RESPONSE`), and the generated
 * plans, tagged `antigravity-ide`. Idempotent — every message carries a stable
 * `sourceId`, so re-importing only adds what's new. Everything is local.
 *
 * Mirrors commands/importCodex.ts; reuses the transcript parser in
 * core/antigravityIdeTranscript.ts and the shared event logger.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  findAntigravityIdeTranscripts,
  locateAntigravityIdeTranscript,
  readAntigravityIdeTranscript,
  type AntigravityIdeTranscriptInfo,
} from '../core/antigravityIdeTranscript.ts';
import { importedSourceIds, logEvent } from '../core/events.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../core/plans.ts';
import { makeId } from '../core/ids.ts';
import { requireActiveAuthor } from '../core/authors.ts';
import { requirePaths, type AuthorPaths } from '../core/storage.ts';
import { oneLine } from '../core/text.ts';
import type { HookTranscript } from '../plugins/types.ts';

export interface ImportAntigravityIdeOptions {
  /** List this machine's Antigravity IDE conversations and exit. */
  list?: boolean;
  /** Also log the IDE's text replies (not just your prompts). Default true. */
  withResponses?: boolean;
  /** Import a specific transcript `.jsonl` by path (escape hatch). */
  file?: string;
  /** Import into a specific Showtail session id. */
  session?: string;
  cwd?: string;
}

export interface AntigravityIdeImportResult {
  prompts: number;
  responses: number;
  plans: number;
  skipped: number;
  first?: string;
  last?: string;
}

/**
 * Log a parsed IDE transcript's prompts/replies/plans into the trail, tagged
 * `antigravity-ide`. Idempotent: messages whose sourceId is already in the trail
 * are skipped. (The parser drops raw edits — those are captured by the VS Code
 * extension / live hooks, not the import.)
 */
export async function importAntigravityIdeTranscript(
  author: AuthorPaths,
  transcript: HookTranscript,
  options: { withResponses?: boolean; sessionId?: string; batchId?: string } = {},
): Promise<AntigravityIdeImportResult> {
  const seen = importedSourceIds(author);
  const result: AntigravityIdeImportResult = {
    prompts: 0,
    responses: 0,
    plans: 0,
    skipped: 0,
  };
  // A user prompt opens a turn; the reply/plan that follow link back via this id.
  let currentTurnId: string | undefined;
  const stamp = (ts?: string): void => {
    if (!ts) return;
    if (!result.first || ts < result.first) result.first = ts;
    if (!result.last || ts > result.last) result.last = ts;
  };

  for (const msg of transcript.messages) {
    if (msg.role === 'assistant' && options.withResponses === false) continue;
    const type =
      msg.role === 'user'
        ? 'prompt'
        : msg.role === 'assistant'
          ? 'ai_output'
          : msg.role === 'plan'
            ? 'plan'
            : null;
    if (type === null) continue; // 'edit' / unknown roles are not imported here.

    if (seen.has(msg.sourceId)) {
      result.skipped += 1;
      continue;
    }
    seen.add(msg.sourceId);

    const tags = ['imported'];
    if (type === 'plan') {
      tags.push(msg.approved === false ? PLAN_REVISED_TAG : PLAN_APPROVED_TAG);
    }

    const { event } = await logEvent(author, {
      type,
      text: msg.text,
      tool: 'antigravity-ide',
      timestamp: msg.timestamp,
      sourceId: msg.sourceId,
      batchId: options.batchId,
      sessionId: options.sessionId,
      tags,
      turnId: msg.role === 'user' ? undefined : currentTurnId,
    });
    if (msg.role === 'user') currentTurnId = event.id;

    if (type === 'prompt') result.prompts += 1;
    else if (type === 'ai_output') result.responses += 1;
    else result.plans += 1;
    stamp(msg.timestamp);
  }

  return result;
}

/** Resolve which transcript to import: `--file`, a `<conversationId>`, else newest. */
function resolveTranscript(
  target: string | undefined,
  options: ImportAntigravityIdeOptions,
): AntigravityIdeTranscriptInfo | null {
  if (options.file) {
    if (!existsSync(options.file)) throw new Error(`File not found: ${options.file}`);
    // Derive the conversation id from the brain layout when possible (stable
    // sourceIds); otherwise fall back to the file's own name.
    const m = /([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/.exec(
      options.file,
    );
    return {
      path: options.file,
      sessionId: m?.[1] ?? basename(options.file),
      mtimeMs: 0,
    };
  }
  if (target) {
    const found = findAntigravityIdeTranscripts();
    const chosen = found.find(
      (t) => t.sessionId === target || t.sessionId.startsWith(target),
    );
    if (!chosen) {
      throw new Error(
        `No Antigravity IDE conversation matching "${target}". ` +
          'Run `showtail import antigravity-ide --list` to see what is available.',
      );
    }
    return chosen;
  }
  return locateAntigravityIdeTranscript(undefined); // newest
}

/**
 * Import an Antigravity IDE conversation transcript. With no target, imports the
 * most recent conversation; `--list` prints what's available; `--file` imports a
 * specific transcript; a `<conversationId>` imports that conversation directly.
 */
export async function runImportAntigravityIde(
  target: string | undefined,
  options: ImportAntigravityIdeOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });

  if (options.list) {
    listConversations();
    return;
  }

  const info = resolveTranscript(target, options);
  if (!info) {
    console.log('No Antigravity IDE conversations were found on disk.');
    console.log('If you have a transcript elsewhere, point at it with --file <path>.');
    return;
  }

  const transcript = readAntigravityIdeTranscript(info, paths.root);
  if (transcript.messages.length === 0) {
    console.log('Nothing to import — that conversation has no prompts or replies yet.');
    return;
  }

  const res = await importAntigravityIdeTranscript(author, transcript, {
    withResponses: options.withResponses,
    sessionId: options.session,
    batchId: makeId('imp'),
  });
  printResult(res, options.withResponses !== false);
}

/** Print the conversations available to import, so a student can pick one by id. */
function listConversations(): void {
  const found = findAntigravityIdeTranscripts();
  if (found.length === 0) {
    console.log('No Antigravity IDE conversations were found on disk.');
    return;
  }
  console.log(`Antigravity IDE conversations (${found.length}, newest first):`);
  console.log('');
  for (const t of found) {
    let first = '';
    try {
      first =
        readAntigravityIdeTranscript(t, t.path).messages.find((m) => m.role === 'user')
          ?.text ?? '';
    } catch {
      /* best-effort preview */
    }
    console.log(`  ${t.sessionId}`);
    if (first) console.log(`     first: ${oneLine(first, 100)}`);
  }
  console.log('');
  console.log('Import one with:  showtail import antigravity-ide <conversation-id>');
  console.log('Or run `showtail import antigravity-ide` to import the most recent.');
}

function printResult(res: AntigravityIdeImportResult, withResponses: boolean): void {
  const total = res.prompts + res.responses + res.plans;
  if (total === 0) {
    console.log(
      res.skipped > 0
        ? `Already imported — nothing new (${res.skipped} item(s) already in your trail).`
        : 'Nothing new to import.',
    );
    return;
  }
  const parts = [`${res.prompts} prompt(s)`];
  if (withResponses) parts.push(`${res.responses} response(s)`);
  if (res.plans) parts.push(`${res.plans} plan(s)`);
  console.log(
    `Imported from Antigravity IDE: ${parts.join(', ')} (tool: antigravity-ide).`,
  );
  if (res.skipped) console.log(`  ${res.skipped} already-imported item(s) skipped.`);

  console.log('');
  console.log('This was all local — nothing left your machine.');
  console.log('Not what you expected? Undo this whole batch:  showtail import undo');
  console.log(
    'Looks right? `showtail report` shows it interleaved with your other work.',
  );
}
