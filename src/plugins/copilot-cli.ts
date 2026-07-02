/**
 * GitHub Copilot CLI — GitHub's `copilot` command (github-copilot-sdk). A
 * live-capture connect plugin: lifecycle hooks in a dedicated Showtail hooks
 * file (~/.copilot/hooks/showtail.json for user, .github/hooks/showtail.json for
 * project) plus a dedicated `.instructions.md` file, mirroring Codex/Gemini CLI.
 *
 * Distinct from the github-copilot VS Code plugin (which owns
 * .github/copilot-instructions.md and .github/instructions/showtail.instructions.md);
 * this CLI plugin deliberately writes only to its own paths so the two never
 * collide. See src/core/copilotCli.ts for the path/collision rationale.
 *
 * Like every plugin, this is the whole footprint of adding the environment:
 * nothing in src/core/hook.ts or the CLI knows Copilot CLI exists; it's
 * discovered through the registry.
 */
import { runCopilotCliInstall, runCopilotCliUninstall } from '../commands/copilotCli.ts';
import {
  copilotCliAutoCaptureActive,
  copilotCliInstructionsState,
  installCopilotCliHooks,
  resolveCopilotCliTarget,
  writeCopilotCliInstructions,
} from '../core/copilotCli.ts';
import {
  findCopilotCliSession,
  parseCopilotCliTranscript,
} from '../core/copilotCliTranscript.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import {
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  type HookPayload,
} from '../core/hookInput.ts';
import { existsSync, readFileSync } from 'node:fs';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * On stop, read the just-finished session's `events.jsonl` and normalize it for
 * the generic stop reconcile. Copilot CLI hook payloads carry no transcript
 * path, so — like Codex — we locate the session under ~/.copilot/session-state
 * ourselves: by the payload's session id, else the newest. Returns null when
 * nothing readable is found, so stop stays a safe no-op.
 */
function copilotCliGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const sid = extractSessionId(raw as HookPayload | null);
  const info = findCopilotCliSession(sid);
  if (!info || !existsSync(info.path)) return null;
  try {
    return parseCopilotCliTranscript(readFileSync(info.path, 'utf8'), root);
  } catch {
    return null; // Unreadable/unsupported log — nothing to capture.
  }
}

export const copilotCliPlugin: EnvironmentPlugin = {
  id: 'copilot-cli',
  cliName: 'copilot-cli',
  aliases: ['copilotcli'],
  label: 'GitHub Copilot CLI',

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

    detect: () => commandOnPath('copilot') || homeDirExists('.copilot'),

    autoConnect(cwd) {
      const target = resolveCopilotCliTarget('user', cwd);
      writeCopilotCliInstructions(target, {});
      installCopilotCliHooks(target);
      return { hooks: true };
    },

    install: (opts) =>
      runCopilotCliInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runCopilotCliUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const state = copilotCliInstructionsState(resolveCopilotCliTarget('project', cwd));
      const hooksActive = copilotCliAutoCaptureActive(cwd);
      return {
        connected: state.installed || hooksActive,
        hooksActive,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },

    hooks: {
      // Copilot CLI's PostToolUse / UserPromptSubmit payloads use file_path-style
      // edit tools (write/edit), so the same field extractors as Claude apply.
      // Best-effort: a hook must never crash the host session.
      parse(raw) {
        const p = raw as HookPayload;
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          editedFiles: extractEditedFiles(p),
          suggestedDiff: extractSuggestedCode(p),
        };
      },
      // Copilot CLI's own config/state live under ~/.copilot; never snapshot edits there.
      internalPaths: [/(^|[\\/])\.copilot([\\/]|$)/],
      // Copilot CLI hook payloads carry no transcript path, so we locate the
      // session's events.jsonl under ~/.copilot/session-state ourselves (by
      // session id, else newest) and read AI replies from it. Note: Copilot CLI
      // records no plan/decision construct in its event log, so only assistant
      // replies (and prompts) are reconciled — see copilotCliTranscript.ts.
      getTranscript: copilotCliGetTranscript,
    },
  },
};
