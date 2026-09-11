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
  findCopilotCliExecutable,
  installCopilotCliHooks,
  refreshExistingCopilotCliInstructions,
  resolveCopilotCliTarget,
  writeCopilotCliInstructions,
} from '../core/copilotCli.ts';
import {
  findCopilotCliSessions,
  findCopilotCliSession,
  parseCopilotCliTranscript,
  readCopilotCliSessionFile,
} from '../core/copilotCliTranscript.ts';
import {
  extractCopilotCliEditedFiles,
  extractCopilotCliPrompt,
  extractCopilotCliSessionId,
  extractCopilotCliSuggestedCode,
  type CopilotCliHookPayload,
} from '../core/hookInput.ts';
import { existsSync, readFileSync } from 'node:fs';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * On stop, read the just-finished session's `events.jsonl` and normalize it for
 * the generic stop reconcile. Copilot CLI hook payloads carry no transcript
 * path, so — like Codex — we locate the session under ~/.copilot/session-state
 * ourselves by the payload's exact session id. Returns null when nothing
 * readable is found, so stop stays a safe no-op.
 */
function copilotCliGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const sid = extractCopilotCliSessionId(raw as CopilotCliHookPayload | null);
  if (!sid) return null;
  const info = findCopilotCliSession(sid);
  if (!info || !existsSync(info.path)) return null;
  try {
    const transcript = parseCopilotCliTranscript(readFileSync(info.path, 'utf8'), root);
    if (transcript.sessionId && transcript.sessionId !== info.sessionId) return null;
    return { ...transcript, sessionId: transcript.sessionId ?? info.sessionId };
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
        description: 'disable auto-capture hooks at the selected scope',
      },
      {
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions (take the latest)',
      },
    ],
    applicableFlags: ['user', 'project', 'hooks', 'force'],

    detect: () => findCopilotCliExecutable() !== null,

    // Not pre-wired before install: pre-seed firing is unverified for Copilot CLI, so
    // it's connected once detected rather than written ahead of install.
    prewireSafe: false,

    autoConnect(cwd) {
      const target = resolveCopilotCliTarget('user', cwd);
      writeCopilotCliInstructions(target, {});
      installCopilotCliHooks(target);
      // Automatic sweeps run around machine-readable commands too, so they must
      // never print. Status surfaces any customized block that still needs review.
      refreshExistingCopilotCliInstructions(cwd);
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

    uninstall: (opts) =>
      runCopilotCliUninstall({ user: opts.user, all: opts.all, cwd: opts.cwd }),

    status(cwd) {
      const projectState = copilotCliInstructionsState(
        resolveCopilotCliTarget('project', cwd),
      );
      const userState = copilotCliInstructionsState(resolveCopilotCliTarget('user', cwd));
      const hooksActive = copilotCliAutoCaptureActive(cwd);
      const installed = projectState.installed || userState.installed;
      return {
        connected: installed || hooksActive,
        hooksActive,
        updateAvailable: installed
          ? projectState.updateAvailable || userState.updateAvailable
          : undefined,
      };
    },

    hooks: {
      acceptsPayload(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const payload = raw as Record<string, unknown>;
        const sid = payload.sessionId;
        if (typeof sid !== 'string' || sid.trim().length === 0) return false;
        return !['session_id', 'hook_event_name', 'transcript_path'].some((key) =>
          Object.prototype.hasOwnProperty.call(payload, key),
        );
      },
      dedupeInvocations: true,
      // Copilot CLI's postToolUse / userPromptSubmitted payloads use a shape of
      // their own: `{ sessionId, cwd, prompt, toolName, toolArgs (JSON string) }`.
      // We read them with Copilot-specific extractors (Claude's field names don't
      // match). Best-effort: a hook must never crash the host session.
      parse(raw) {
        const p = raw as CopilotCliHookPayload;
        return {
          nativeSessionId: extractCopilotCliSessionId(p),
          prompt: extractCopilotCliPrompt(p),
          editedFiles: extractCopilotCliEditedFiles(p),
          suggestedDiff: extractCopilotCliSuggestedCode(p),
        };
      },
      // Copilot CLI's own config/state live under ~/.copilot; never snapshot edits there.
      internalPaths: [/(^|[\\/])\.copilot([\\/]|$)/],
      // Copilot CLI hook payloads carry no transcript path, so we locate the
      // session's events.jsonl under ~/.copilot/session-state ourselves (by
      // exact session id) and read AI replies from it. Note: Copilot CLI
      // records no plan/decision construct in its event log, so only assistant
      // replies (and prompts) are reconciled — see copilotCliTranscript.ts.
      getTranscript: copilotCliGetTranscript,
    },
  },

  migration: {
    discover: () =>
      findCopilotCliSessions().map((info) => ({
        path: info.path,
        providerSessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
      })),
    read(candidate, root) {
      return readCopilotCliSessionFile(candidate.path, root);
    },
  },
};
