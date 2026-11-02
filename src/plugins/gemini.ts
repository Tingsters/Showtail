/**
 * Google Gemini (the web app) — import-only. A share link or pasted transcript
 * is parsed by core/gemini.ts and recorded into the trail.
 */
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
  },
};
