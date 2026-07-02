/**
 * Antigravity IDE — Google's agentic IDE (a VS Code fork driven by the Gemini
 * language server). A live-capture connect plugin.
 *
 * The IDE shares `~/.gemini` with the Antigravity CLI and gemini-cli but reads
 * its hooks from ONE global file in a *named-hooks* shape — `~/.gemini/config/
 * hooks.json` — distinct from the CLI's `.agents/` / `~/.gemini/antigravity-cli/`
 * map-shaped files. It writes a uniquely-named rules file (`AGY-IDE.showtail.md`)
 * and never touches GEMINI.md / AGENTS.md / the CLI's AGY.showtail.md. See
 * src/core/antigravityIde.ts for the full path/shape rationale.
 */
import {
  runAntigravityIdeInstall,
  runAntigravityIdeUninstall,
} from '../commands/antigravityIde.ts';
import {
  antigravityIdeAutoCaptureActive,
  antigravityIdeInstructionsState,
  installAntigravityIdeHooks,
  resolveAntigravityIdeTarget,
  writeAntigravityIdeInstructions,
} from '../core/antigravityIde.ts';
import {
  locateAntigravityIdeTranscript,
  readAntigravityIdeTranscript,
} from '../core/antigravityIdeTranscript.ts';
import { homeDirExists } from '../core/detect.ts';
import {
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  type HookPayload,
} from '../core/hookInput.ts';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * Locate this session's Antigravity IDE transcript and normalize it for the
 * generic stop reconcile. The IDE writes a per-conversation JSONL transcript
 * under `~/.gemini/antigravity-ide/brain/<id>/.system_generated/logs/
 * transcript.jsonl` (same layout as the CLI); the hook payload carries no
 * transcript path, so we find it ourselves — by the payload's session id (the
 * conversation/brain dir name), else the newest brain. Returns null when none is
 * on disk or it can't be parsed, leaving Stop a no-op.
 */
function antigravityIdeGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const sid = extractSessionId(raw as HookPayload | null);
  const info = locateAntigravityIdeTranscript(sid);
  if (!info) return null;
  try {
    return readAntigravityIdeTranscript(info, root);
  } catch {
    return null; // Unreadable/unsupported transcript — nothing to capture.
  }
}

export const antigravityIdePlugin: EnvironmentPlugin = {
  id: 'antigravity-ide',
  cliName: 'antigravity-ide',
  aliases: ['agy-ide', 'antigravityide'],
  label: 'Antigravity IDE',

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

    detect: () => homeDirExists('.antigravity-ide') || homeDirExists('.gemini'),

    autoConnect(cwd) {
      const target = resolveAntigravityIdeTarget('user', cwd);
      writeAntigravityIdeInstructions(target, {});
      installAntigravityIdeHooks(target);
      return { hooks: true };
    },

    install: (opts) =>
      runAntigravityIdeInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runAntigravityIdeUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const state = antigravityIdeInstructionsState(
        resolveAntigravityIdeTarget('project', cwd),
      );
      const hooksActive = antigravityIdeAutoCaptureActive(cwd);
      return {
        connected: state.installed || hooksActive,
        hooksActive,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },

    hooks: {
      // The IDE's PostToolUse/UserPromptSubmit payloads use file_path-style edit
      // tools, so the same field extractors as Claude apply. Best-effort: see the
      // validation caveat in the plan if the IDE's payload field names differ.
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
      // workspace .agents/ dir (our rules file). Never snapshot edits to these.
      internalPaths: [/(^|[\\/])\.gemini([\\/]|$)/, /(^|[\\/])\.agents([\\/]|$)/],
      // The IDE writes a per-conversation JSONL transcript under
      // ~/.gemini/antigravity-ide/brain; locate it (by session id, else newest)
      // and reconcile prompts/replies/plans from it at Stop.
      getTranscript: antigravityIdeGetTranscript,
    },
  },
};
