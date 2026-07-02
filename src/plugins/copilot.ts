/**
 * GitHub Copilot — project-scoped instructions in `.github/`, plus a VS Code
 * extension that does the actual capture. No lifecycle hooks, so no `hooksActive`
 * and no setup auto-connect (the extension sets each project up on first open).
 */
import { runCopilotInstall, runCopilotUninstall } from '../commands/copilot.ts';
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
};
