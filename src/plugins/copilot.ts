/**
 * GitHub Copilot — project-scoped instructions in `.github/`, plus a VS Code
 * extension that does the actual capture. No lifecycle hooks, so no `hooksActive`
 * and no setup auto-connect (the extension sets each project up on first open).
 *
 * It also imports: native Copilot Chat persists every session to disk as JSON
 * (`…/workspaceStorage/<hash>/chatSessions/<uuid>.json`), so `import copilot`
 * back-fills past chats and the extension's live watcher feeds new turns through
 * the same path. See src/core/copilotChatTranscript.ts.
 */
import { runCopilotInstall, runCopilotUninstall } from '../commands/copilot.ts';
import { runImportCopilot } from '../commands/importCopilot.ts';
import { copilotState, resolveCopilotTarget } from '../core/copilot.ts';
import { commandOnPath } from '../core/detect.ts';
import type { EnvironmentPlugin } from './types.ts';

const MARKETPLACE_ID = 'Tingsters.showtail';

export const copilotPlugin: EnvironmentPlugin = {
  id: 'github-copilot',
  cliName: 'copilot',
  aliases: ['github-copilot'],
  label: 'GitHub Copilot',

  connect: {
    scopes: ['project'],
    flags: [
      {
        name: 'extension',
        flag: '--no-extension',
        description: 'skip the VS Code extension guidance',
      },
      {
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions (take the latest)',
      },
    ],
    applicableFlags: ['extension', 'force'],

    detect: () => commandOnPath('code') || commandOnPath('code-insiders'),

    // Copilot is project-scoped and the extension auto-installs its instructions
    // on first open, so `setup` connects nothing globally — only shows guidance.
    setupGuidance: [
      'VS Code detected. For GitHub Copilot capture, install the extension:',
      `  code --install-extension ${MARKETPLACE_ID}`,
      '  (It sets up each project automatically the first time you open it.)',
    ],

    install: (opts) =>
      runCopilotInstall({ extension: opts.extension, force: opts.force, cwd: opts.cwd }),

    uninstall: (opts) => runCopilotUninstall({ cwd: opts.cwd }),

    status(cwd) {
      const state = copilotState(resolveCopilotTarget(cwd));
      return {
        connected: state.installed,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },
  },

  import: {
    command: 'copilot',
    aliases: ['github-copilot', 'copilot-chat'],
    description:
      'Import an existing native VS Code Copilot Chat session from disk into your trail.\n' +
      "With no target, opens an interactive picker of this project's sessions " +
      '(choose one or several); --list prints the same list non-interactively.',
    shape: 'transcript',
    run: (source, opts) =>
      runImportCopilot(source, {
        list: opts.list,
        withResponses: opts.withResponses,
        file: opts.file,
        session: opts.session,
        quiet: opts.quiet,
        cwd: opts.cwd,
      }),
  },
};
