/**
 * OpenAI Codex — AGENTS.md instructions + lifecycle hooks in `.codex/`, with a
 * `config.toml` `features.hooks` toggle. All of that lives in core/codex.ts and
 * commands/codex.ts; this module exposes it through the plugin contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import { runCodexInstall, runCodexUninstall } from '../commands/codex.ts';
import { runImportCodex } from '../commands/importCodex.ts';
import {
  codexAutoCaptureActive,
  codexHooksFeatureEnabled,
  codexInstructionsState,
  enableCodexHooksFeature,
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../core/codex.ts';
import {
  findRollouts,
  parseCodexRollout,
  rolloutCwdFromFile,
  type CodexRolloutInfo,
} from '../core/codexTranscript.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import {
  applyPatchEdits,
  extractApplyPatchFiles,
  extractPrompt,
  extractSessionId,
  extractShellCommandFiles,
  extractSuggestedCode,
  type HookPayload,
} from '../core/hookInput.ts';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * Locate the rollout file this hook payload belongs to. Codex hook payloads
 * don't carry a transcript path, so we find it ourselves: prefer the rollout
 * whose name matches the payload's session id; otherwise fall back to the most
 * recently modified rollout (the one this just-stopped session wrote). Returns
 * null when nothing plausible is on disk.
 */
function locateRollout(payload: HookPayload | null): CodexRolloutInfo | null {
  const rollouts = findRollouts();
  if (rollouts.length === 0) return null;
  const sid = extractSessionId(payload);
  if (sid) {
    const byId = rollouts.find((r) => r.sessionId === sid);
    if (byId) return byId;
  }
  return rollouts[0]!; // newest first
}

/** Read the relevant rollout and normalize it for the generic stop reconcile. */
function codexGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const info = locateRollout(raw as HookPayload | null);
  if (!info || !existsSync(info.path)) return null;
  try {
    return parseCodexRollout(readFileSync(info.path, 'utf8'), root);
  } catch {
    return null; // Unreadable/unsupported rollout — nothing to capture.
  }
}

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

    // Not pre-wired before install: `codex doctor` accepts a Showtail-seeded config
    // (it doesn't break), but Codex gates hooks behind *persisted hook trust*
    // (`--dangerously-bypass-hook-trust`) and hook firing could not be confirmed for a
    // pre-seeded config. Codex is connected instead once it's actually detected — the
    // same flow that works for an installed Codex today.
    prewireSafe: false,

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

    hooks: {
      parse(raw) {
        const p = raw as HookPayload;
        // Per-file edits with clean diffs (apply_patch) + bare shell-written
        // files; deduped, apply_patch (diff-bearing) winning over a bare path.
        const edits = new Map(extractShellCommandFiles(p).map((f) => [f, { file: f }]));
        for (const e of applyPatchEdits(p)) edits.set(e.file, e);
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          // editedFiles kept for the legacy/no-`edits` consumers; `edits` drives
          // rendering so each file shows only its own change (and deletions).
          editedFiles: [
            ...new Set([...extractApplyPatchFiles(p), ...extractShellCommandFiles(p)]),
          ],
          edits: [...edits.values()],
          suggestedDiff: extractSuggestedCode(p),
        };
      },
      internalPaths: [/(^|[\\/])\.codex([\\/]|$)/],
      // Codex hook payloads carry no transcript path, so we locate the session's
      // rollout under ~/.codex/sessions ourselves (by session id, else newest).
      getTranscript: codexGetTranscript,
      // Codex edits via raw `shell_command` (PowerShell Set-Content, redirects)
      // whose path may live in a shell variable — unparsable from the command.
      // Let the hook recover such edits from git when the payload yields nothing.
      recoverEditsFromGit: true,
    },
  },

  import: {
    command: 'codex',
    aliases: ['openai-codex'],
    description:
      'Import an existing OpenAI Codex session from its on-disk rollout into your trail.\n' +
      "With no target, opens an interactive picker of this project's sessions " +
      '(choose one or several); --list prints the same list non-interactively.',
    shape: 'transcript',
    run: (source, opts) =>
      runImportCodex(source, {
        list: opts.list,
        withResponses: opts.withResponses,
        file: opts.file,
        session: opts.session,
        cwd: opts.cwd,
      }),
  },

  migration: {
    discover: () =>
      findRollouts().map((info) => ({
        path: info.path,
        providerSessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
        cwd: rolloutCwdFromFile(info.path),
      })),
    read(candidate, root) {
      return parseCodexRollout(readFileSync(candidate.path, 'utf8'), root);
    },
  },
};
