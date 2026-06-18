import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  fetchSharedConversation,
  importConversation,
  parseShareHtml,
  parseTranscript,
  type ParsedConversation,
} from '../core/chatgpt.ts';
import { readClipboard, readClipboardHtml } from '../core/clipboard.ts';
import { CHATGPT_HTML, parseConversationHtml, type HtmlParseConfig } from '../core/pasteHtml.ts';
import { latestBatchId, readAllEvents, removeEventsByBatch } from '../core/events.ts';
import { makeId } from '../core/ids.ts';
import { requirePaths } from '../core/storage.ts';

export interface ImportChatgptOptions {
  withResponses?: boolean;
  file?: string;
  session?: string;
  cwd?: string;
  /** Read a pasted transcript (from the clipboard interactively, or stdin when piped). */
  paste?: boolean;
  /** Read the transcript from the system clipboard. */
  clipboard?: boolean;
  /** Skip the clipboard preview/confirmation prompt. */
  yes?: boolean;
  /** A pasted transcript supplied directly (used by tests instead of stdin). */
  text?: string;
  /** Stamp pasted events with this date (YYYY-MM-DD) so they land on the timeline. */
  date?: string;
}

const SHARE_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/share\/[\w-]+/i;

/** A saved page still carries the React Router stream markers; a transcript won't. */
function looksLikeSharePage(content: string): boolean {
  return /__reactRouterContext|streamController\.enqueue\(/.test(content);
}

/** Where a pasted transcript came from: exact roles (HTML) or raw text. */
export type PasteSource =
  | { conversation: ParsedConversation; raw?: undefined; fromClipboard: boolean; viaHtml: true }
  | { raw: string; conversation?: undefined; fromClipboard: boolean; viaHtml: false };

/**
 * Decide where a pasted transcript comes from. Interactive `--paste` (or an
 * explicit `--clipboard`) reads the **clipboard**, so nothing is typed into the
 * terminal — pasting multi-line text into a shell runs each line as a command.
 * Prefer the clipboard's HTML (exact prompt/response roles); fall back to its
 * plain text. When stdin is piped (scripts, `echo | …`), read stdin as before.
 */
export async function readPasteSource(
  opts: { clipboard?: boolean; paste?: boolean },
  htmlConfig: HtmlParseConfig,
  fileCmd: string,
): Promise<PasteSource> {
  if (opts.clipboard || (opts.paste && process.stdin.isTTY)) {
    let html: string | null = null;
    try {
      html = readClipboardHtml();
    } catch {
      html = null;
    }
    const conversation = html ? parseConversationHtml(html, htmlConfig) : null;
    if (conversation && conversation.messages.length > 0) {
      return { conversation, fromClipboard: true, viaHtml: true };
    }
    try {
      return { raw: readClipboard(), fromClipboard: true, viaHtml: false };
    } catch (err) {
      // No clipboard tool — fall back to a clear message pointing at --file.
      throw new Error(`${(err as Error).message}\n  e.g. ${fileCmd}`);
    }
  }
  // Running under Bun (piped CLI + tests): the simplest reliable reader.
  return { raw: await Bun.stdin.text(), fromClipboard: false, viaHtml: false };
}

/** Show the user what they're about to import, and how roles were determined. */
export function previewImport(
  conversation: ParsedConversation,
  meta: { viaHtml: boolean; markersFound: boolean },
): void {
  const prompts = conversation.messages.filter((m) => m.role === 'user').length;
  const replies = conversation.messages.filter((m) => m.role === 'assistant').length;
  process.stderr.write('\n');
  if (meta.viaHtml) {
    process.stderr.write(
      `Recovered roles from the page: ${prompts} prompt(s), ${replies} AI reply(ies).\n`,
    );
  } else if (meta.markersFound) {
    process.stderr.write(
      `Detected ${prompts} prompt(s) and ${replies} reply(ies) from role markers.\n`,
    );
  } else {
    process.stderr.write(
      `No role markers found — recording all ${conversation.messages.length} block(s) ` +
        'as YOUR prompts. For exact roles, use the share link.\n',
    );
  }
  process.stderr.write('  ┌─ preview ─────────────────────────────\n');
  for (const m of conversation.messages.slice(0, 8)) {
    const who = m.role === 'assistant' ? 'AI ' : 'You';
    process.stderr.write(`  │ ${who} │ ${oneLine(m.text, 60)}\n`);
  }
  if (conversation.messages.length > 8) {
    process.stderr.write(`  │ … (${conversation.messages.length - 8} more)\n`);
  }
  process.stderr.write('  └───────────────────────────────────────\n');
}

/** Ask a yes/no question on the terminal. Reads a single line, so paste-safe. */
export function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Parse `--date` (a day, or any ISO datetime) into epoch seconds; clear error otherwise. */
export function dateToEpochSeconds(date: string): number {
  const ms = Date.parse(date.length <= 10 ? `${date}T12:00:00Z` : date);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not understand --date "${date}". Use a day like 2026-06-10.`);
  }
  return Math.floor(ms / 1000);
}

/** Collapse a prompt to a single readable line for the skim list. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Import a ChatGPT conversation into the trail. Three input modes:
 *  - a share URL (preferred): fetched and parsed;
 *  - `--file` a saved share page (parsed the same way) or a saved transcript;
 *  - `--paste` a transcript on stdin (the manual backup).
 */
export async function runImportChatgpt(
  source: string | undefined,
  options: ImportChatgptOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);

  let conversation: ParsedConversation;
  let isPaste = false;
  let markersFound = false;

  if (options.text !== undefined || options.paste || options.clipboard) {
    const src: PasteSource =
      options.text !== undefined
        ? { raw: options.text, fromClipboard: false, viaHtml: false }
        : await readPasteSource(options, CHATGPT_HTML, 'showtail import chatgpt --file <path>');

    let viaHtml = false;
    if (src.viaHtml) {
      conversation = src.conversation; // exact roles from the page markup
      markersFound = true;
      viaHtml = true;
    } else {
      if (src.fromClipboard && src.raw.trim() === '') {
        console.log('Your clipboard is empty — copy the conversation first, then try again.');
        return;
      }
      const parsed = parseTranscript(src.raw);
      conversation = parsed.conversation;
      markersFound = parsed.markersFound;
    }
    isPaste = true;

    // Let the user see what they're about to import, and confirm, before writing.
    if (src.fromClipboard && !options.yes) {
      previewImport(conversation, { viaHtml, markersFound });
      if (!(await confirm('Import this? [y/N]'))) {
        console.log('Cancelled — nothing imported.');
        return;
      }
    }
  } else if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    const content = readFileSync(options.file, 'utf8');
    if (looksLikeSharePage(content)) {
      conversation = await parseShareHtml(content);
    } else {
      const parsed = parseTranscript(content);
      conversation = parsed.conversation;
      markersFound = parsed.markersFound;
      isPaste = true;
    }
  } else {
    if (!source || !SHARE_RE.test(source)) {
      throw new Error(
        'Pass a ChatGPT share URL like https://chatgpt.com/share/<id>\n' +
          '(create one with "Share" in ChatGPT), use --file <saved-page>, or copy the\n' +
          'conversation and use --paste (reads your clipboard) if the link will not work.',
      );
    }
    conversation = await parseShareHtml(await fetchSharedConversation(source));
  }

  if (conversation.messages.length === 0) {
    console.log('Nothing to import — I could not find any text in that input.');
    return;
  }

  // A paste has no timestamps; --date places it on the cross-tool timeline,
  // with a 1-second step per message so the order is preserved.
  if (isPaste && options.date) {
    const base = dateToEpochSeconds(options.date);
    conversation.messages.forEach((m, i) => {
      m.createTime = base + i;
    });
  }

  const batchId = makeId('imp');
  const res = await importConversation(paths, conversation, 'chatgpt', {
    withResponses: options.withResponses,
    sessionId: options.session,
    batchId,
  });

  if (isPaste) {
    printPasteResult(paths, batchId, res, markersFound, Boolean(options.withResponses));
  } else {
    printShareResult(res, Boolean(options.withResponses));
  }
}

function printShareResult(
  res: Awaited<ReturnType<typeof importConversation>>,
  withResponses: boolean,
): void {
  const totalNew = res.prompts + res.responses;
  if (totalNew === 0) {
    if (res.skipped > 0) {
      console.log(
        `Already imported "${res.title}" — nothing new (${res.skipped} message(s) already in your trail).`,
      );
    } else {
      console.log(`No prompts found in "${res.title}".`);
    }
  } else {
    const parts = [`${res.prompts} prompt(s)`];
    if (withResponses) parts.push(`${res.responses} response(s)`);
    console.log(`Imported from "${res.title}": ${parts.join(', ')} (tool: chatgpt).`);
    if (res.skipped) console.log(`  ${res.skipped} already-imported message(s) skipped.`);
    if (res.first && res.last) console.log(`  Spanned ${res.first} → ${res.last}.`);
  }
  console.log('');
  console.log('Run `showtail report` to see it interleaved with your other tools.');
  console.log(
    'Privacy: a share link is public on OpenAI’s servers — delete it once imported.',
  );
}

function printPasteResult(
  paths: ReturnType<typeof requirePaths>,
  batchId: string,
  res: Awaited<ReturnType<typeof importConversation>>,
  markersFound: boolean,
  withResponses: boolean,
): void {
  const recorded = readAllEvents(paths).filter(
    (e) => e.batchId === batchId && e.type === 'prompt',
  );

  if (res.prompts + res.responses === 0) {
    console.log(
      res.skipped > 0
        ? `Already imported — nothing new (${res.skipped} message(s) already in your trail).`
        : 'Nothing new to import.',
    );
    return;
  }

  const parts = [`${res.prompts} prompt(s)`];
  if (withResponses && res.responses > 0) parts.push(`${res.responses} response(s)`);
  console.log(`Recorded ${parts.join(' and ')} from your paste (tool: chatgpt).`);

  if (!markersFound) {
    console.log('');
    console.log(
      "No 'You said:/ChatGPT said:' markers were in your paste, so I recorded everything",
    );
    console.log(
      "as YOUR prompts. If any of it was ChatGPT's reply, undo below and re-copy with those",
    );
    console.log('markers — or use the share link, which separates them exactly.');
  }

  console.log('');
  console.log('Here’s what I recorded — skim it:');
  recorded.forEach((e, i) => console.log(`  ${i + 1}. ${oneLine(e.text)}`));
  if (res.skipped) console.log(`  (${res.skipped} already-imported message(s) skipped.)`);

  console.log('');
  console.log('Not yours? Undo this whole batch:  showtail import undo');
  console.log('Looks right? Run `showtail report` to see it under “Prompts used”.');
}

/** Undo the most recent import in one step (removes that batch's events). */
export async function runImportUndo(options: { cwd?: string } = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const batchId = latestBatchId(paths);
  if (!batchId) {
    console.log('Nothing to undo — no imported events found.');
    return;
  }
  const removed = removeEventsByBatch(paths, batchId);
  console.log(`Undid the last import — removed ${removed} event(s).`);
}
