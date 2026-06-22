import { existsSync, readFileSync } from 'node:fs';
import {
  fetchSharedConversation,
  importConversation,
  parseShareHtml,
  parseTranscript,
  type ParsedConversation,
} from '../core/gemini.ts';
import { requireActiveAuthor } from '../core/authors.ts';
import { makeId } from '../core/ids.ts';
import { requirePaths } from '../core/storage.ts';
import { GEMINI_HTML } from '../core/pasteHtml.ts';
import { printPasteResult, printShareResult } from '../core/importResults.ts';
import {
  confirm,
  dateToEpochSeconds,
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
  const author = await requireActiveAuthor(paths, { cwd: paths.root });

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
  const res = await importConversation(author, conversation, 'google-gemini', {
    withResponses: options.withResponses,
    sessionId: options.session,
    batchId,
  });

  const print = { tool: 'google-gemini', assistantLabel: 'Gemini', privacyOrg: 'Google' };
  if (isPaste) {
    printPasteResult(
      paths,
      batchId,
      res,
      markersFound,
      Boolean(options.withResponses),
      print,
    );
  } else {
    printShareResult(res, Boolean(options.withResponses), print);
  }
}
