/**
 * OpenAI Codex — AGENTS.md instructions + lifecycle hooks in `.codex/`, with a
 * `config.toml` `features.hooks` toggle. All of that lives in core/codex.ts and
 * commands/codex.ts; this module exposes it through the plugin contract.
 */
import { runCodexInstall, runCodexUninstall } from '../commands/codex.ts';
import {
  codexAutoCaptureActive,
  codexHooksFeatureEnabled,
  codexInstructionsState,
  enableCodexHooksFeature,
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../core/codex.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import type { EnvironmentPlugin } from './types.ts';

export const codexPlugin: EnvironmentPlugin = {
  id: 'codex',
  cliName: 'codex',
  aliases: [],
  label: 'OpenAI Codex',

  connect: {
    scopes: ['user', 'project'],
    flags: [
      {
        name: 'user',
        flag: '--user',
        description: 'install for your user, all projects',
      },
      {
        name: 'project',
        flag: '--project',
        description: 'install for this project only [default]',
      },
      {
        name: 'hooks',
        flag: '--no-hooks',
        description: 'skip auto-capture hooks; log prompts/edits yourself',
      },
      {
        name: 'yes',
        flag: '--yes',
        description: 'enable Codex hooks in config.toml without prompting',
      },
      {
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions (take the latest)',
      },
    ],
    applicableFlags: ['user', 'project', 'hooks', 'yes', 'force'],

    detect: () => commandOnPath('codex') || homeDirExists('.codex'),

    autoConnect(cwd) {
      const target = resolveCodexTarget('user', cwd);
      writeCodexInstructions(target, {});
      installCodexHooks(target);
      if (!codexHooksFeatureEnabled(target.configToml)) {
        enableCodexHooksFeature(target.configToml);
      }
      return { hooks: true };
    },

    install: (opts) =>
      runCodexInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        yes: opts.yes,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runCodexUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const state = codexInstructionsState(resolveCodexTarget('project', cwd));
      return {
        connected: state.installed,
        hooksActive: codexAutoCaptureActive(cwd),
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },
  },
};
