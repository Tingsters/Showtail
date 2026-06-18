import { existsSync, readFileSync } from 'node:fs';
import {
  fetchSharedConversation,
  importConversation,
  parseShareHtml,
  parseTranscript,
  type ParsedConversation,
} from '../core/gemini.ts';
import { readAllEvents } from '../core/events.ts';
import { makeId } from '../core/ids.ts';
import { requirePaths } from '../core/storage.ts';
import { GEMINI_HTML } from '../core/pasteHtml.ts';
import {
  confirm,
  dateToEpochSeconds,
  oneLine,
  previewImport,
  readPasteSource,
  type PasteSource,
} from './import.ts';

export interface ImportGeminiOptions {
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
  /** Stamp timestamp-less events with this date (YYYY-MM-DD) so they land on the timeline. */
  date?: string;
}

const SHARE_RE =
  /^https:\/\/(?:gemini\.google\.com\/share|g\.co\/gemini\/share|share\.gemini\.google)\/[\w-]+/i;

/** A saved Gemini RPC response carries the batchexecute markers; a transcript won't. */
function looksLikeRpcBody(content: string): boolean {
  return /"wrb\.fr"/.test(content) || content.trimStart().startsWith(")]}'");
}

/** A saved Gemini *page* (HTML) — which does NOT contain the conversation. */
function looksLikeGeminiPage(content: string): boolean {
  return /window\.WIZ_global_data|<c-wiz/.test(content);
}

/**
 * Import a Google Gemini conversation into the trail. Input modes:
 *  - a share URL (preferred): the conversation is fetched via Gemini's
 *    batchexecute RPC and decoded;
 *  - `--file` a saved RPC response (decoded the same way) or a saved transcript;
 *  - `--paste` a transcript on stdin (the manual backup).
 */
export async function runImportGemini(
  source: string | undefined,
  options: ImportGeminiOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);

  let conversation: ParsedConversation;
  let isPaste = false;
  let markersFound = false;

  if (options.text !== undefined || options.paste || options.clipboard) {
    const src: PasteSource =
      options.text !== undefined
        ? { raw: options.text, fromClipboard: false, viaHtml: false }
        : await readPasteSource(
            options,
            GEMINI_HTML,
            'showtail import gemini --file <path>',
          );

    let viaHtml = false;
    if (src.viaHtml) {
      conversation = src.conversation; // exact roles from the page markup
      markersFound = true;
      viaHtml = true;
    } else {
      if (src.fromClipboard && src.raw.trim() === '') {
        console.log(
          'Your clipboard is empty — copy the conversation first, then try again.',
        );
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
    if (looksLikeRpcBody(content)) {
      conversation = await parseShareHtml(content);
    } else if (looksLikeGeminiPage(content)) {
      throw new Error(
        'That looks like a saved Gemini page, which does not contain the conversation\n' +
          '(Gemini loads it in the browser). Import from the share link directly, or copy\n' +
          'the chat text and use --paste.',
      );
    } else {
      const parsed = parseTranscript(content);
      conversation = parsed.conversation;
      markersFound = parsed.markersFound;
      isPaste = true;
    }
  } else {
    if (!source || !SHARE_RE.test(source)) {
      throw new Error(
        'Pass a Gemini share URL like https://gemini.google.com/share/<id>\n' +
          '(create one with "Share" in Gemini), use --file <saved-transcript>, or copy the\n' +
          'conversation and use --paste (reads your clipboard).',
      );
    }
    conversation = await parseShareHtml(await fetchSharedConversation(source));
  }

  if (conversation.messages.length === 0) {
    console.log('Nothing to import — I could not find any text in that input.');
    return;
  }

  // Gemini conversations (pasted or shared) carry no per-message timestamps;
  // --date places them on the cross-tool timeline, 1 second apart so order holds.
  if (options.date && conversation.messages.every((m) => m.createTime == null)) {
    const base = dateToEpochSeconds(options.date);
    conversation.messages.forEach((m, i) => {
      m.createTime = base + i;
    });
  }

  const batchId = makeId('imp');
  const res = await importConversation(paths, conversation, 'google-gemini', {
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
    console.log(
      `Imported from "${res.title}": ${parts.join(', ')} (tool: google-gemini).`,
    );
    if (res.skipped) console.log(`  ${res.skipped} already-imported message(s) skipped.`);
    if (res.first && res.last) console.log(`  Spanned ${res.first} → ${res.last}.`);
  }
  console.log('');
  console.log('Run `showtail report` to see it interleaved with your other tools.');
  console.log(
    'Privacy: a share link is public on Google’s servers — delete it once imported.',
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
  console.log(`Recorded ${parts.join(' and ')} from your paste (tool: google-gemini).`);

  if (!markersFound) {
    console.log('');
    console.log(
      "No 'You said:/Gemini said:' markers were in your paste, so I recorded everything",
    );
    console.log(
      "as YOUR prompts. If any of it was Gemini's reply, undo below and re-copy with those",
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
