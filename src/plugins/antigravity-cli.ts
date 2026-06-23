/**
 * Antigravity CLI — Google's `agy` command. A live-capture connect plugin that
 * REPLACES the now-EOL Gemini CLI: dedicated `hooks.json` plus a uniquely-named
 * rules file, mirroring Codex.
 *
 * Antigravity shares `~/.gemini` with the (EOL) gemini-cli plugin and reads
 * GEMINI.md / AGENTS.md (managed by gemini-cli / codex), so this plugin
 * deliberately writes to NEITHER. It uses Antigravity-specific paths — the
 * workspace `.agents/` dir and `~/.gemini/antigravity-cli/` — for both its
 * hooks file and its instructions file. See src/core/antigravityCli.ts for the
 * full non-collision rationale.
 */
import {
  runAntigravityCliInstall,
  runAntigravityCliUninstall,
} from '../commands/antigravityCli.ts';
import {
  antigravityCliAutoCaptureActive,
  antigravityCliInstructionsState,
  installAntigravityCliHooks,
  resolveAntigravityCliTarget,
  writeAntigravityCliInstructions,
} from '../core/antigravityCli.ts';
import {
  locateAntigravityCliTranscript,
  readAntigravityCliTranscript,
} from '../core/antigravityCliTranscript.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import {
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  type HookPayload,
} from '../core/hookInput.ts';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * Locate this session's Antigravity transcript and normalize it for the generic
 * stop reconcile. Antigravity writes a JSONL transcript per conversation under
 * `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`;
 * the hook payload carries no transcript path, so we find it ourselves — by the
 * payload's session id (the conversation/brain dir name), else the newest brain.
 * Captures the student's prompts, the planner's replies, and (Antigravity's
 * signature) its generated PLANS / task lists. Returns null when none is on disk
 * or it can't be parsed, leaving Stop a no-op.
 */
function antigravityCliGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const sid = extractSessionId(raw as HookPayload | null);
  const info = locateAntigravityCliTranscript(sid);
  if (!info) return null;
  try {
    return readAntigravityCliTranscript(info, root);
  } catch {
    return null; // Unreadable/unsupported transcript — nothing to capture.
  }
}

export const antigravityCliPlugin: EnvironmentPlugin = {
  id: 'antigravity-cli',
  cliName: 'antigravity-cli',
  aliases: ['antigravity', 'agy'],
  label: 'Antigravity CLI',

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

    detect: () => commandOnPath('agy') || homeDirExists('.gemini'),

    autoConnect(cwd) {
      const target = resolveAntigravityCliTarget('user', cwd);
      writeAntigravityCliInstructions(target, {});
      installAntigravityCliHooks(target);
      return { hooks: true };
    },

    install: (opts) =>
      runAntigravityCliInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runAntigravityCliUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const state = antigravityCliInstructionsState(
        resolveAntigravityCliTarget('project', cwd),
      );
      const hooksActive = antigravityCliAutoCaptureActive(cwd);
      return {
        connected: state.installed || hooksActive,
        hooksActive,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },

    hooks: {
      // Antigravity CLI's PostToolUse/UserPromptSubmit payloads use file_path-style
      // edit tools (write_file/replace/edit), so the same field extractors as
      // Claude apply. Best-effort: see the validation caveat if field names differ.
      parse(raw) {
        const p = raw as HookPayload;
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          editedFiles: extractEditedFiles(p),
          suggestedDiff: extractSuggestedCode(p),
        };
      },
      // Antigravity's own dirs: ~/.gemini (shared config/transcripts) and the
      // workspace .agents/ dir (hooks + rules). Never snapshot edits to these.
      internalPaths: [/(^|[\\/])\.gemini([\\/]|$)/, /(^|[\\/])\.agents([\\/]|$)/],
      // Antigravity writes a per-conversation JSONL transcript under
      // ~/.gemini/antigravity-cli/brain; locate it (by session id, else newest)
      // and reconcile prompts/replies/plans from it at Stop.
      getTranscript: antigravityCliGetTranscript,
    },
  },
};
