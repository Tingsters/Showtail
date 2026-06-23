/**
 * `showtail import codex` — back-fill a trail from an existing OpenAI Codex
 * session's on-disk rollout (`~/.codex/sessions/.../rollout-*.jsonl`).
 *
 * Mirrors commands/importClaude.ts: with no target an interactive picker lists
 * this project's rollouts (choose one or several); `--list` prints the same list
 * non-interactively; `--file` imports a specific rollout; a `<target>` id imports
 * that session directly. Everything is local — the roles are explicit in the
 * rollout, so there is no guessing about user vs. assistant.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  findProjectRollouts,
  importCodexTranscript,
  readRolloutFile,
  summarizeRollouts,
  type CodexImportResult,
  type CodexRolloutSummary,
} from '../core/codexTranscript.ts';
import { makeId } from '../core/ids.ts';
import { requireActiveAuthor } from '../core/authors.ts';
import { requirePaths, type AuthorPaths } from '../core/storage.ts';
import { oneLine } from '../core/text.ts';

export interface ImportCodexOptions {
  /** List this project's rollouts and exit. */
  list?: boolean;
  /** Also log Codex's text replies (not just your prompts). */
  withResponses?: boolean;
  /** Import a specific rollout `.jsonl` by path (escape hatch). */
  file?: string;
  /** Import into a specific Showtail session id. */
  session?: string;
  cwd?: string;
}

/** Trim milliseconds from an ISO timestamp for friendlier output. */
function trimMs(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** A friendly "how long ago" label for a file's modification time. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/** A rough "~25 min" / "~2 h" span between the first and last message, if known. */
function spanLabel(first?: string, last?: string): string {
  if (!first || !last) return '';
  const ms = Date.parse(last) - Date.parse(first);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return '~<1 min';
  if (min < 90) return `~${min} min`;
  const hours = Math.round(min / 60);
  return `~${hours} h`;
}

/** The marker shown after an already-imported session in listings. */
function importMarker(state: CodexRolloutSummary['importState']): string {
  if (state === 'full') return '  [imported]';
  if (state === 'partial') return '  [partially imported]';
  return '';
}

/** Print one summary as the numbered block shown in the picker / `--list`. */
function printSummary(s: CodexRolloutSummary, ordinal: number): void {
  const span = spanLabel(s.first, s.last);
  const meta = [`${s.promptCount} prompt(s)`, `${s.editCount} edit(s)`];
  if (span) meta.push(span);
  console.log(
    `  ${ordinal}. ${relativeTime(s.info.mtimeMs)}    ${meta.join(', ')}${importMarker(s.importState)}`,
  );
  if (s.firstPrompt) console.log(`     first: ${oneLine(s.firstPrompt, 100)}`);
  if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) {
    console.log(`     last:  ${oneLine(s.lastPrompt, 100)}`);
  }
  console.log(`     id: ${s.info.sessionId}`);
  console.log('');
}

/**
 * Import an existing Codex session rollout from disk. With no target, an
 * interactive picker lists this project's sessions; `--list` prints the same
 * list non-interactively; `--file` imports a specific `.jsonl`; a `<target>` id
 * imports that session directly.
 */
export async function runImportCodex(
  target: string | undefined,
  options: ImportCodexOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });

  if (options.list) {
    listRollouts(author);
    return;
  }

  // Explicit single-rollout targets (a file or an id) keep their direct behavior.
  if (options.file || target) {
    const path = resolveRolloutPath(author, target, options);
    if (!path) return; // A message was already printed.
    await importPaths(author, [path], options);
    return;
  }

  // No target: discover this project's sessions and let the student choose.
  const summaries = summarizeRollouts(author);
  if (summaries.length === 0) {
    console.log('No Codex sessions were found for this project on disk.');
    console.log('If you have a rollout elsewhere, point at it with --file <path>.');
    return;
  }

  // Non-interactive (piped/CI): fall back to the most recent, as before.
  if (!process.stdin.isTTY) {
    const latest = summaries[0]!;
    console.log(
      `Importing the most recent session (${latest.info.sessionId}). ` +
        'Run in a terminal to pick from the full list.',
    );
    await importPaths(author, [latest.info.path], options);
    return;
  }

  const chosen = await pickSessions(summaries);
  if (!chosen || chosen.length === 0) {
    console.log('Nothing selected — no changes made.');
    return;
  }
  await importPaths(
    author,
    chosen.map((s) => s.info.path),
    options,
  );
}

/** Resolve which single rollout file to import, printing guidance when it can't. */
function resolveRolloutPath(
  author: AuthorPaths,
  target: string | undefined,
  options: ImportCodexOptions,
): string | null {
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    return options.file;
  }

  const found = findProjectRollouts(author.shared.root);
  if (found.length === 0) {
    console.log('No Codex sessions were found for this project on disk.');
    console.log('If you have a rollout elsewhere, point at it with --file <path>.');
    return null;
  }

  if (target) {
    const chosen = found.find(
      (t) => t.sessionId === target || t.sessionId.startsWith(target),
    );
    if (!chosen) {
      throw new Error(
        `No Codex session matching "${target}" for this project. ` +
          'Run `showtail import codex --list` to see what is available.',
      );
    }
    return chosen.path;
  }

  return null; // Unreachable: callers handle the no-target case.
}

/**
 * Import one or more rollout files as a single undoable batch, then print a
 * combined result. Overlapping messages dedupe automatically because every
 * import re-reads the trail's source ids.
 */
async function importPaths(
  author: AuthorPaths,
  filePaths: string[],
  options: ImportCodexOptions,
): Promise<void> {
  const batchId = makeId('imp');
  const totals: CodexImportResult = {
    title: '',
    prompts: 0,
    responses: 0,
    edits: 0,
    skipped: 0,
  };
  let imported = 0;

  for (const path of filePaths) {
    const transcript = readRolloutFile(path, author.shared.root);
    if (transcript.messages.length === 0) continue;
    const res = await importCodexTranscript(author, transcript, {
      withResponses: options.withResponses,
      sessionId: options.session,
      batchId,
    });
    imported += 1;
    totals.prompts += res.prompts;
    totals.responses += res.responses;
    totals.edits += res.edits;
    totals.skipped += res.skipped;
    if (res.first && (!totals.first || res.first < totals.first))
      totals.first = res.first;
    if (res.last && (!totals.last || res.last > totals.last)) totals.last = res.last;
  }

  if (imported === 0) {
    console.log(
      'Nothing to import — no prompts or edits were found in those rollout(s).',
    );
    return;
  }

  printResult(totals, Boolean(options.withResponses), filePaths.length);
}

/**
 * Interactively pick one or more sessions to import. Prints the numbered list,
 * then reads a single line: a comma/space list with optional ranges, `all`, or
 * `q`/empty to cancel. Re-prompts once on invalid input, then gives up.
 */
async function pickSessions(
  summaries: CodexRolloutSummary[],
): Promise<CodexRolloutSummary[] | null> {
  console.log(`Codex sessions for this project (${summaries.length}):`);
  console.log('');
  summaries.forEach((s, i) => printSummary(s, i + 1));

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await new Promise<string>((resolve) => {
          rl.question(
            `Pick sessions to import [e.g. 1,3 or 'all', q to quit]: `,
            resolve,
          );
        })
      )
        .trim()
        .toLowerCase();

      if (answer === '' || answer === 'q' || answer === 'quit') return null;
      if (answer === 'all' || answer === '*') return summaries;

      const chosen = parseSelection(answer, summaries.length);
      if (chosen) return chosen.map((i) => summaries[i]!);

      process.stderr.write(
        `  Didn't understand that. Enter numbers between 1 and ${summaries.length} (e.g. 1,3), 'all', or q.\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Parse a selection string like "1,3" or "1-2 4" into zero-based, de-duplicated
 * indices (in input order). Returns `null` if any token is invalid or out of
 * range, so the caller can re-prompt.
 */
export function parseSelection(input: string, count: number): number[] | null {
  const tokens = input.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const out: number[] = [];
  const add = (n: number): boolean => {
    if (!Number.isInteger(n) || n < 1 || n > count) return false;
    if (!out.includes(n - 1)) out.push(n - 1);
    return true;
  };

  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (lo > hi) return null;
      for (let n = lo; n <= hi; n++) {
        if (!add(n)) return null;
      }
      continue;
    }
    if (!/^\d+$/.test(token) || !add(Number(token))) return null;
  }

  return out.length > 0 ? out : null;
}

/** Print the available rollouts so a student can pick one by id. */
function listRollouts(author: AuthorPaths): void {
  const summaries = summarizeRollouts(author);
  if (summaries.length === 0) {
    console.log('No Codex sessions were found for this project on disk.');
    return;
  }

  console.log(`Codex sessions for this project (${summaries.length}):`);
  console.log('');
  summaries.forEach((s, i) => printSummary(s, i + 1));
  console.log('Import one with:  showtail import codex <session-id>');
  console.log('Or run `showtail import codex` to pick interactively.');
}

function printResult(
  res: CodexImportResult,
  withResponses: boolean,
  sessionCount: number,
): void {
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
  const from =
    sessionCount > 1 ? `${sessionCount} Codex sessions` : 'your Codex session';
  console.log(`Imported from ${from}: ${parts.join(', ')} (tool: codex).`);
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
