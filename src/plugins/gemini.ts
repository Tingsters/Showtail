/**
 * Google Gemini (the web app) — import-only. A share link or pasted transcript
 * is parsed by core/gemini.ts and recorded into the trail. Distinct from the
 * Gemini CLI (see gemini-cli.ts), which is a live-capture connect plugin.
 */
import { runImportGemini } from '../commands/importGemini.ts';
import type { EnvironmentPlugin } from './types.ts';

export const geminiPlugin: EnvironmentPlugin = {
  id: 'google-gemini',
  cliName: 'gemini',
  aliases: ['google-gemini'],
  label: 'Google Gemini',

  import: {
    command: 'gemini',
    description:
      'Import a Google Gemini conversation from a share link (gemini.google.com/share/…).\n' +
      'If a link will not work, paste the conversation with --paste (or --file a transcript).',
    shape: 'share',
    run: (source, opts) =>
      runImportGemini(source, {
        withResponses: opts.withResponses,
        paste: opts.paste,
        clipboard: opts.clipboard,
        yes: opts.yes,
        file: opts.file,
        date: opts.date,
        session: opts.session,
        cwd: opts.cwd,
      }),
  },
};
