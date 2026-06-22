/**
 * Gemini CLI — Google's `gemini` command. A live-capture connect plugin:
 * hooks in `.gemini/settings.json` plus GEMINI.md instructions, mirroring Codex.
 * Distinct from the Google Gemini web app (gemini.ts), which is import-only.
 *
 * This module is the whole footprint of adding a new environment — proof the
 * core stayed tool-agnostic: nothing in src/core/hook.ts or the CLI knows Gemini
 * CLI exists; it's discovered through the registry.
 */
import { runGeminiCliInstall, runGeminiCliUninstall } from '../commands/geminiCli.ts';
import {
  geminiCliAutoCaptureActive,
  geminiCliInstructionsState,
  installGeminiCliHooks,
  resolveGeminiCliTarget,
  writeGeminiCliInstructions,
} from '../core/geminiCli.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import type { EnvironmentPlugin } from './types.ts';

export const geminiCliPlugin: EnvironmentPlugin = {
  id: 'gemini-cli',
  cliName: 'gemini-cli',
  aliases: ['geminicli'],
  label: 'Gemini CLI',

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
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions (take the latest)',
      },
    ],
    applicableFlags: ['user', 'project', 'hooks', 'force'],

    detect: () => commandOnPath('gemini') || homeDirExists('.gemini'),

    autoConnect(cwd) {
      const target = resolveGeminiCliTarget('user', cwd);
      writeGeminiCliInstructions(target, {});
      installGeminiCliHooks(target);
      return { hooks: true };
    },

    install: (opts) =>
      runGeminiCliInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runGeminiCliUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const state = geminiCliInstructionsState(resolveGeminiCliTarget('project', cwd));
      const hooksActive = geminiCliAutoCaptureActive(cwd);
      return {
        connected: state.installed || hooksActive,
        hooksActive,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },
  },
};
