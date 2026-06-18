import { existsSync, readFileSync } from 'node:fs';
import {
  findProjectTranscripts,
  importClaudeTranscript,
  parseClaudeTranscript,
  readTranscriptFile,
  type ClaudeImportResult,
} from '../core/claudeCode.ts';
import { makeId } from '../core/ids.ts';
import { requirePaths, type ShowtailPaths } from '../core/storage.ts';

export interface ImportClaudeOptions {
  /** List this project's transcripts and exit. */
  list?: boolean;
  /** Also log Claude's text replies (not just your prompts). */
  withResponses?: boolean;
  /** Import a specific transcript .jsonl by path (escape hatch). */
  file?: string;
  /** Import into a specific Showtail session id. */
  session?: string;
  cwd?: string;
}

/** Collapse text to a single readable line for listings. */
function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Trim milliseconds from an ISO timestamp for friendlier output. */
function trimMs(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Import an existing Claude Code session transcript from disk. With no target,
 * the most recent transcript for this project is imported; `--list` shows them
 * all; `--file` imports a specific `.jsonl`.
 */
export async function runImportClaudeCode(
  target: string | undefined,
  options: ImportClaudeOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);

  if (options.list) {
    listTranscripts(paths);
    return;
  }

  const path = resolveTranscriptPath(paths, target, options);
  if (!path) return; // A message was already printed.

  const transcript = readTranscriptFile(path, paths.root);
  if (transcript.messages.length === 0) {
    console.log('Nothing to import — no prompts or edits were found in that transcript.');
    return;
  }

  const batchId = makeId('imp');
  const res = await importClaudeTranscript(paths, transcript, {
    withResponses: options.withResponses,
    sessionId: options.session,
    batchId,
  });

  printResult(res, Boolean(options.withResponses));
}

/** Resolve which transcript file to import, printing guidance when it can't. */
function resolveTranscriptPath(
  paths: ShowtailPaths,
  target: string | undefined,
  options: ImportClaudeOptions,
): string | null {
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    return options.file;
  }

  const found = findProjectTranscripts(paths.root);
  if (found.length === 0) {
    console.log('No Claude Code transcripts were found for this project on disk.');
    console.log('If you have a transcript elsewhere, point at it with --file <path>.');
    return null;
  }

  if (target) {
    const chosen = found.find(
      (t) => t.sessionId === target || t.sessionId.startsWith(target),
    );
    if (!chosen) {
      throw new Error(
        `No Claude Code session matching "${target}" for this project. ` +
          'Run `showtail import claude-code --list` to see what is available.',
      );
    }
    return chosen.path;
  }

  const latest = found[0]!;
  console.log(
    `Importing the most recent session (${latest.sessionId}). ` +
      'Use --list to pick a different one.',
  );
  return latest.path;
}

/** Print the available transcripts so a student can pick one by id. */
function listTranscripts(paths: ShowtailPaths): void {
  const found = findProjectTranscripts(paths.root);
  if (found.length === 0) {
    console.log('No Claude Code transcripts were found for this project on disk.');
    return;
  }

  console.log(`Claude Code transcripts for this project (${found.length}):`);
  console.log('');
  for (const t of found) {
    let promptCount = 0;
    let firstPrompt = '';
    try {
      const parsed = parseClaudeTranscript(readFileSync(t.path, 'utf8'), paths.root);
      const prompts = parsed.messages.filter((m) => m.role === 'user');
      promptCount = prompts.length;
      firstPrompt = prompts[0]?.text ?? '';
    } catch {
      // Couldn't parse it — still list the id so it can be tried with --file.
    }
    console.log(`  ${t.sessionId}`);
    console.log(
      `    ${trimMs(new Date(t.mtimeMs).toISOString())} · ${promptCount} prompt(s)`,
    );
    if (firstPrompt) console.log(`    first: ${oneLine(firstPrompt)}`);
    console.log('');
  }
  console.log('Import one with:  showtail import claude-code <session-id>');
}

function printResult(res: ClaudeImportResult, withResponses: boolean): void {
  const total = res.prompts + res.responses + res.edits;
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
  parts.push(`${res.edits} edit(s)`);
  console.log(
    `Imported from your Claude Code session: ${parts.join(', ')} (tool: claude-code).`,
  );
  if (res.skipped) console.log(`  ${res.skipped} already-imported item(s) skipped.`);
  if (res.first && res.last) {
    console.log(`  Spanned ${trimMs(res.first)} → ${trimMs(res.last)}.`);
  }

  console.log('');
  console.log('This was all local — nothing left your machine.');
  console.log('Not what you expected? Undo this whole batch:  showtail import undo');
  console.log(
    'Looks right? `showtail report` shows it interleaved with your other work.',
  );
}
