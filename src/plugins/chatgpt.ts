/**
 * ChatGPT — import-only. A share link, saved page, or pasted transcript is
 * parsed by core/chatgpt.ts and recorded into the trail. No live capture.
 */
import type { EnvironmentPlugin } from './types.ts';

export const chatgptPlugin: EnvironmentPlugin = {
  id: 'chatgpt',
  cliName: 'chatgpt',
  aliases: [],
  label: 'ChatGPT',

  import: {
    command: 'chatgpt',
    description:
      'Import a ChatGPT conversation. A share link is easiest; if it will not work,\n' +
      'paste the conversation instead with --paste (or --file a saved page/transcript).',
    shape: 'share',
  },
};
