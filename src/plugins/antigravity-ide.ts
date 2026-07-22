/**
 * Antigravity IDE — Google's agentic IDE (a VS Code fork driven by the Gemini
 * language server). A live-capture connect plugin.
 *
 * The IDE shares `~/.gemini` with the Antigravity CLI but reads
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
import { runImportAntigravityIde } from '../commands/importAntigravityIde.ts';
import {
  antigravityIdeAutoCaptureActive,
  antigravityIdeInstalledOnHost,
  antigravityIdeInstructionsState,
  resolveAntigravityIdeTarget,
  writeAntigravityIdeInstructions,
} from '../core/antigravityIde.ts';
import { installAntigravityIdeExtension } from '../core/antigravityIdeExtension.ts';
import {
  antigravityIdePlanFiles,
  locateAntigravityIdeTranscript,
  readAntigravityIdeTranscript,
} from '../core/antigravityIdeTranscript.ts';
import { homeDirExists } from '../core/detect.ts';
import {
  extractAntigravityEditedFiles,
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
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions (take the latest)',
      },
    ],
    applicableFlags: ['user', 'project', 'force'],

    detect: () => antigravityIdeInstalledOnHost() || homeDirExists('.antigravity-ide'),

    // Cannot be pre-wired before install: capture rides on a VS Code extension that is
    // installed by shelling out to the IDE's own launcher, which must already exist.
    // There is no config file to pre-seed, so this is only connected once the IDE is
    // actually detected (its autoConnect no-ops when the IDE is absent).
    prewireSafe: false,

    autoConnect(cwd) {
      const target = resolveAntigravityIdeTarget('user', cwd);
      writeAntigravityIdeInstructions(target, {});
      // Capture rides on the VS Code extension, not the IDE's (dead) hooks.
      installAntigravityIdeExtension();
      return { hooks: false };
    },

    install: (opts) =>
      runAntigravityIdeInstall({
        user: opts.user,
        project: opts.project,
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
      // The IDE's PostToolUse payload puts the edited path in `toolCall.args.
      // TargetFile` (PascalCase, JSON-string-encoded), NOT Claude's
      // `tool_input.file_path` — so use the Antigravity extractor first and fall
      // back to the Claude-shaped one. Prompts/replies/plans are recovered from the
      // transcript at Stop, so a missing live `prompt` field is fine.
      parse(raw) {
        const p = raw as HookPayload;
        const edited = extractAntigravityEditedFiles(p);
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          editedFiles: edited.length > 0 ? edited : extractEditedFiles(p),
          suggestedDiff: extractSuggestedCode(p),
        };
      },
      // Antigravity's own dirs: ~/.gemini (shared config/transcripts) and the
      // workspace .agents/ dir (our rules file). Never snapshot edits to these.
      internalPaths: [/(^|[\\/])\.gemini([\\/]|$)/, /(^|[\\/])\.agents([\\/]|$)/],
      // The IDE writes a per-conversation JSONL transcript under
      // ~/.gemini/antigravity-ide/brain; locate it (by session id, else newest)
      // and reconcile prompts/replies/plans from it.
      getTranscript: antigravityIdeGetTranscript,
      // The IDE writes the session's implementation plan to
      // brain/<id>/implementation_plan.md; surface it so the report links the
      // canonical (final) plan file even after later edits.
      planFiles(raw) {
        return antigravityIdePlanFiles(extractSessionId(raw as HookPayload | null));
      },
      // This IDE build only dispatches PostToolUse hooks (PreInvocation/Stop never
      // fire), so reconcile the transcript on post-edit instead of waiting for a
      // Stop that won't come. Idempotent — see HookAdapter.reconcileOnPostEdit.
      reconcileOnPostEdit: true,
    },
  },

  // Live hooks here are unreliable (only PostToolUse fires), so the complete,
  // truthful record is the on-disk brain transcript — importing it captures the
  // full conversation independent of hook timing. See commands/importAntigravityIde.
  import: {
    command: 'antigravity-ide',
    aliases: ['agy-ide'],
    description:
      'Import an Antigravity IDE conversation (its brain transcript) into your trail.',
    shape: 'transcript',
    run: (source, opts) =>
      runImportAntigravityIde(source, {
        list: opts.list,
        withResponses: opts.withResponses,
        file: opts.file,
        session: opts.session,
        cwd: opts.cwd,
        auto: opts.auto,
      }),
  },
};
