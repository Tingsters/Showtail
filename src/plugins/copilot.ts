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
import { findChatSessions, readChatSessionFile } from '../core/copilotChatTranscript.ts';
import { findVsCodeCli, installVsCodeExtension } from '../core/vscodeExtension.ts';
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

    // Detect VS Code even when the `code` CLI isn't on PATH (findVsCodeCli also checks
    // the app-bundle install paths), so auto-install reaches a normal VS Code install.
    detect: () => findVsCodeCli() !== null,

    // Cannot be pre-wired before install: capture rides on the VS Code extension, which is
    // installed via VS Code's own CLI and so needs VS Code already present. Connected
    // (extension installed) the moment VS Code is detected — never pre-seeded.
    prewireSafe: false,

    // Install the Showtail VS Code extension hands-off when VS Code is present. The
    // extension then self-installs the per-project `.github/` instructions on first open,
    // so there's nothing for the student to run. Capture is via the extension, not hooks.
    autoConnect() {
      installVsCodeExtension();
      return { hooks: false };
    },

    // Fallback guidance if VS Code is present but its CLI can't be located to auto-install.
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
        auto: opts.auto,
        cwd: opts.cwd,
      }),
  },

  migration: {
    discover: () =>
      findChatSessions().map((info) => ({
        path: info.path,
        providerSessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
        cwd: info.cwd,
      })),
    read: (candidate, root) => readChatSessionFile(candidate.path, root),
  },
};
