import { existsSync, readFileSync } from 'node:fs';
import {
  fetchSharedConversation,
  importConversation,
  parseShareHtml,
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
