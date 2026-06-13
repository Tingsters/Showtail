import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  fetchSharedConversation,
  importConversation,
  parseExportJson,
  parseShareHtml,
  type ParsedConversation,
} from '../core/chatgpt.ts';
import { requirePaths } from '../core/storage.ts';

export interface ImportChatgptOptions {
  withResponses?: boolean;
  file?: string;
  session?: string;
  cwd?: string;
}

const SHARE_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/share\/[\w-]+/i;

/** Import a ChatGPT conversation from a share link (or a saved page via --file). */
export async function runImportChatgpt(
  source: string | undefined,
  options: ImportChatgptOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);

  let html: string;
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    html = readFileSync(options.file, 'utf8');
  } else {
    if (!source || !SHARE_RE.test(source)) {
      throw new Error(
        'Pass a ChatGPT share URL like https://chatgpt.com/share/<id>\n' +
          '(create one with "Share" in ChatGPT), or use --file <saved-page.html>.',
      );
    }
    html = await fetchSharedConversation(source);
  }

  const conversation = await parseShareHtml(html);
  const res = await importConversation(paths, conversation, {
    withResponses: options.withResponses,
    sessionId: options.session,
  });

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
    if (options.withResponses) parts.push(`${res.responses} response(s)`);
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

export interface ImportExportOptions {
  withResponses?: boolean;
  since?: string;
  match?: string;
  all?: boolean;
  list?: boolean;
  session?: string;
  cwd?: string;
}

/** Read conversations.json out of an export zip, a folder, or the json file itself. */
function readExportJson(path: string): string {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  if (statSync(path).isDirectory()) {
    const inner = join(path, 'conversations.json');
    if (!existsSync(inner)) throw new Error(`No conversations.json found in ${path}.`);
    return readFileSync(inner, 'utf8');
  }
  if (path.toLowerCase().endsWith('.zip')) {
    const files = unzipSync(new Uint8Array(readFileSync(path)));
    const key = Object.keys(files).find((k) => k.endsWith('conversations.json'));
    if (!key) throw new Error('No conversations.json found inside the export zip.');
    return new TextDecoder().decode(files[key]!);
  }
  return readFileSync(path, 'utf8');
}

function convoTimeMs(c: ParsedConversation): number {
  const sec =
    c.createTime ?? c.messages.reduce((m, x) => Math.max(m, x.createTime ?? 0), 0);
  return (sec ?? 0) * 1000;
}

function dateOf(c: ParsedConversation): string {
  const ms = convoTimeMs(c);
  return ms ? new Date(ms).toISOString().slice(0, 10) : '????-??-??';
}

/**
 * Import conversations from a ChatGPT data export (Settings → Data Controls →
 * Export). Because an export is the student's *entire* history, importing
 * requires a filter (--match/--since) or explicit --all; --list previews it.
 */
export async function runImportChatgptExport(
  file: string,
  options: ImportExportOptions,
): Promise<void> {
  const paths = requirePaths(options.cwd);
  let convos = parseExportJson(readExportJson(file));
  const found = convos.length;

  if (options.match) {
    const m = options.match.toLowerCase();
    convos = convos.filter((c) => c.title.toLowerCase().includes(m));
  }
  const sinceMs = options.since ? Date.parse(options.since) : NaN;
  if (!Number.isNaN(sinceMs)) {
    convos = convos.filter((c) => convoTimeMs(c) >= sinceMs);
  }
  convos.sort((a, b) => convoTimeMs(a) - convoTimeMs(b));

  if (options.list) {
    console.log(`${convos.length} of ${found} conversation(s):`);
    for (const c of convos) {
      const prompts = c.messages.filter((x) => x.role === 'user').length;
      console.log(`  [${dateOf(c)}] ${prompts} prompt(s) — ${c.title}`);
    }
    console.log('');
    console.log('Import with --match "<title>", --since <YYYY-MM-DD>, or --all.');
    return;
  }

  if (!options.match && Number.isNaN(sinceMs) && !options.all) {
    throw new Error(
      `This export has ${found} conversation(s) — your whole history. Narrow it with\n` +
        '--match "<title>" or --since <YYYY-MM-DD>, preview with --list, or import all with --all.',
    );
  }

  let prompts = 0;
  let responses = 0;
  let skipped = 0;
  let used = 0;
  for (const c of convos) {
    const res = await importConversation(paths, c, {
      withResponses: options.withResponses,
      sessionId: options.session,
    });
    if (res.prompts + res.responses > 0) used += 1;
    prompts += res.prompts;
    responses += res.responses;
    skipped += res.skipped;
  }

  const parts = [`${prompts} prompt(s)`];
  if (options.withResponses) parts.push(`${responses} response(s)`);
  console.log(
    `Imported ${parts.join(', ')} from ${used} conversation(s) (tool: chatgpt).`,
  );
  if (skipped) console.log(`  ${skipped} already-imported message(s) skipped.`);
  console.log('');
  console.log('Run `showtail report` to see them interleaved with your other tools.');
}
