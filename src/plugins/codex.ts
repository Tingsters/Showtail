/** Codex native-history reader and user-level observer registration. */
import {
  codexToHookTranscript,
  findRollouts,
  parseCodexRollout,
  parseCodexTranscript,
  rolloutCwdFromFile,
  rolloutFormatWarning,
  type CodexRolloutInfo,
} from '@showtail/agent-traces/codex/transcript';
import { existsSync, readFileSync } from 'node:fs';
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
import {
  listThreads,
  openCodexRpc,
  readThreadTranscript,
} from '../core/codexAppServer.ts';
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
import { asString, prop } from '../core/parse.ts';
import type {
  EnvironmentPlugin,
  HookTranscript,
  HookTranscriptMessage,
} from './types.ts';

type CodexEditTool = 'apply_patch' | 'shell_command';

function codexEditTool(payload: HookPayload): CodexEditTool | undefined {
  const names = [payload.tool_name, payload.name]
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim().toLowerCase());
  const unique = [...new Set(names)];
  if (unique.length !== 1) return undefined;
  const name = unique[0];
  return name === 'apply_patch' || name === 'shell_command' ? name : undefined;
}

/**
 * Locate the rollout file this hook payload belongs to. Codex hook payloads
 * don't carry a transcript path, so we find it ourselves: prefer the rollout
 * whose name matches the payload's session id. Returns null when that exact
 * session cannot be located.
 */
function locateRollout(payload: HookPayload | null): CodexRolloutInfo | null {
  const rollouts = findRollouts();
  if (rollouts.length === 0) return null;
  const sid = extractSessionId(payload);
  if (sid) {
    const byId = rollouts.find((r) => r.sessionId === sid);
    if (byId) return byId;
  }
  return null; // A different conversation must never supply this session's history.
}

/**
 * Legacy supplement: the two categories Codex's app-server does not expose as items
 * — `update_plan` plans and blocking `request_user_input` decisions — still live only
 * as function calls in the rollout. Best-effort and silent: a missing or reshaped
 * rollout simply adds nothing, and nothing else depends on it. Replace with the
 * documented `PostToolUse` hook for these tools once verified interactively.
 */
function rolloutSupplement(
  raw: HookPayload | null,
  root: string,
  have: Set<string>,
): HookTranscriptMessage[] {
  try {
    const hinted = asString(prop(raw, 'transcript_path'));
    const path = hinted && existsSync(hinted) ? hinted : locateRollout(raw)?.path;
    if (!path || !existsSync(path)) return [];
    return parseCodexRollout(readFileSync(path, 'utf8'), root, {
      includeOutsideEdits: true,
    }).messages.filter(
      (m) => (m.role === 'plan' || m.role === 'decision') && !have.has(m.sourceId),
    );
  } catch {
    return [];
  }
}

/** Second tier: parse the session's rollout file, flagging a format it cannot read. */
function rolloutFallback(
  raw: HookPayload | null,
  root: string,
): { transcript: HookTranscript | null; warnings: string[] } {
  try {
    const hinted = asString(prop(raw, 'transcript_path'));
    const path = hinted && existsSync(hinted) ? hinted : locateRollout(raw)?.path;
    if (!path || !existsSync(path)) return { transcript: null, warnings: [] };
    const content = readFileSync(path, 'utf8');
    const parsed = parseCodexTranscript(content, root, { includeOutsideEdits: true });
    const warning = rolloutFormatWarning(content, parsed);
    const transcript = codexToHookTranscript(parsed);
    return {
      transcript: transcript.messages.length > 0 ? transcript : null,
      warnings: warning ? [warning] : [],
    };
  } catch {
    return { transcript: null, warnings: [] };
  }
}

/** Insert `extra` into `messages` by timestamp so each lands under its own turn. */
function mergeByTime(
  messages: HookTranscriptMessage[],
  extra: HookTranscriptMessage[],
): HookTranscriptMessage[] {
  if (extra.length === 0) return messages;
  const all = [...messages, ...extra];
  if (all.some((m) => !m.timestamp)) return all;
  return all
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.timestamp!.localeCompare(b.m.timestamp!) || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Build the transcript for a Stop reconcile. Source of truth is Codex's own
 * app-server (documented, stable item types, immune to rollout-format changes). If it
 * is unavailable, fall back to what the hook payload itself carries — the prompt (live
 * hook) and `Stop.last_assistant_message` (the documented final reply) — and say so in
 * `warnings` rather than capturing silently less.
 */
async function codexGetTranscript(
  raw: unknown,
  root: string,
): Promise<HookTranscript | null> {
  const payload = raw as HookPayload | null;
  const threadId = extractSessionId(payload);
  const model = asString(prop(payload, 'model'));
  const lastReply = asString(prop(payload, 'last_assistant_message'))?.trim();
  const turnId = asString(prop(payload, 'turn_id'));
  const warnings: string[] = [];

  let transcript: HookTranscript | null = null;
  if (threadId) {
    try {
      const read = await readThreadTranscript(threadId, {
        root,
        model,
        includeOutsideEdits: true,
      });
      transcript = codexToHookTranscript(read.transcript);
      if (transcript.messages.length === 0) {
        warnings.push(
          `Codex's app-server returned no history for thread ${threadId.slice(0, 8)}`,
        );
      }
      const supplement = rolloutSupplement(
        payload,
        root,
        new Set(transcript.messages.map((m) => m.sourceId)),
      );
      transcript.messages = mergeByTime(transcript.messages, supplement);
    } catch (error) {
      warnings.push(
        `Codex's app-server was unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      // Second tier: the rollout file reader. Fine for older Codex, blind to the
      // newer format — which `rolloutFormatWarning` turns into a visible warning.
      const fallback = rolloutFallback(payload, root);
      warnings.push(...fallback.warnings);
      transcript = fallback.transcript;
    }
  }

  if (!transcript) {
    // Hook-only baseline: nothing to read, so anchor on the prompt the live hook
    // just recorded and keep whatever the payload gives us.
    if (!lastReply)
      return warnings.length > 0 ? { sessionId: threadId, messages: [], warnings } : null;
    transcript = { sessionId: threadId, anchorToCurrentTurn: true, messages: [] };
  }

  // The final reply is a documented hook field, so make sure it is always present
  // even when the history read was partial or lagging.
  if (
    lastReply &&
    !transcript.messages.some(
      (m) => m.role === 'assistant' && m.text.trim() === lastReply,
    )
  ) {
    transcript.messages.push({
      role: 'assistant',
      text: lastReply,
      timestamp: new Date().toISOString(),
      sourceId: `codex:final:${turnId ?? threadId ?? 'unknown'}`,
      model,
      isFinal: true,
    });
  }
  if (warnings.length > 0) transcript.warnings = warnings;
  return transcript;
}

export const codexPlugin: EnvironmentPlugin = {
  id: 'codex',
  cliName: 'codex',
  aliases: [],
  label: 'OpenAI Codex',

  connect: {
    scopes: ['user'],
    flags: [
      {
        name: 'user',
        flag: '--user',
        description: 'install for your user, all projects [default]',
      },
      {
        name: 'hooks',
        flag: '--no-hooks',
        description: 'install instructions only; automatic capture stays off',
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
    applicableFlags: ['user', 'hooks', 'yes', 'force'],

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

    uninstall: (opts) =>
      runCodexUninstall({ user: opts.user, all: opts.all, cwd: opts.cwd }),

    status(cwd) {
      const projectState = codexInstructionsState(resolveCodexTarget('project', cwd));
      const userState = codexInstructionsState(resolveCodexTarget('user', cwd));
      const hooksActive = codexAutoCaptureActive(cwd);
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
      parse(raw) {
        const p = raw as HookPayload;
        const editTool = codexEditTool(p);
        // Per-file edits with clean diffs (apply_patch) + bare shell-written
        // files; deduped, apply_patch (diff-bearing) winning over a bare path.
        const shellFiles =
          editTool === 'shell_command' ? extractShellCommandFiles(p) : [];
        const patchEdits = editTool === 'apply_patch' ? applyPatchEdits(p) : [];
        const edits = new Map(shellFiles.map((file) => [file, { file }]));
        for (const edit of patchEdits) edits.set(edit.file, edit);
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          // editedFiles kept for the legacy/no-`edits` consumers; `edits` drives
          // rendering so each file shows only its own change (and deletions).
          editedFiles:
            editTool === 'apply_patch'
              ? extractApplyPatchFiles(p)
              : editTool === 'shell_command'
                ? shellFiles
                : [],
          edits: [...edits.values()],
          suggestedDiff: editTool === 'apply_patch' ? extractSuggestedCode(p) : undefined,
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
  },

  migration: {
    async discoverNative() {
      const rpc = await openCodexRpc({ requestTimeoutMs: 5000 });
      try {
        return (await listThreads(rpc)).map((t) => ({
          path: '',
          providerSessionId: t.id,
          cwd: t.cwd,
          mtimeMs: t.updatedAt ? t.updatedAt * 1000 : 0,
        }));
      } finally {
        rpc.close();
      }
    },
    discover: () =>
      findRollouts().map((info) => ({
        path: info.path,
        providerSessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
        cwd: rolloutCwdFromFile(info.path),
      })),
    async read(candidate, root) {
      const fallback = parseCodexRollout(
        candidate.path ? readFileSync(candidate.path, 'utf8') : '',
        root,
        {
          includeOutsideEdits: true,
        },
      );
      try {
        const read = await readThreadTranscript(candidate.providerSessionId, {
          root,
          includeOutsideEdits: true,
          openRpc: () => openCodexRpc({ requestTimeoutMs: 5000 }),
        });
        const preferred = codexToHookTranscript(read.transcript);
        // Per-turn rollout context is more precise than a thread's current model.
        const nativeModels = new Map(
          fallback.messages
            .filter((m) => m.role === 'assistant' && m.model)
            .map((m) => [m.sourceId, m.model]),
        );
        for (const m of preferred.messages)
          if (nativeModels.has(m.sourceId)) m.model = nativeModels.get(m.sourceId);
        const nativeContexts = new Map(
          fallback.messages.filter((m) => m.context).map((m) => [m.sourceId, m.context]),
        );
        for (const m of preferred.messages)
          if (nativeContexts.has(m.sourceId)) m.context = nativeContexts.get(m.sourceId);
        if (
          preferred.messages.some((m) => m.role === 'user') &&
          preferred.messages.filter((m) => m.role === 'user').length >=
            fallback.messages.filter((m) => m.role === 'user').length
        )
          return preferred;
      } catch {
        /* The exact thread's rollout remains available offline. */
      }
      fallback.warnings = [
        ...(fallback.warnings ?? []),
        'CODEX_FILE_FALLBACK: app-server history unavailable or incomplete; reconciled the local rollout.',
      ];
      return fallback;
    },
  },
};
