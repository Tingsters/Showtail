/**
 * Antigravity CLI — Google's `agy` command. A live-capture connect plugin with
 * a dedicated `hooks.json` plus a uniquely-named rules file, mirroring Codex.
 *
 * Antigravity shares `~/.gemini` with other tools and reads GEMINI.md /
 * AGENTS.md (AGENTS.md is managed by codex), so this plugin
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
import { existsSync, readFileSync } from 'node:fs';
import {
  antigravityCliPlanFiles,
  locateAntigravityCliTranscript,
  parseAntigravityCliTranscript,
  readAntigravityCliTranscript,
} from '../core/antigravityCliTranscript.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import {
  extractAgyEditedFiles,
  extractAgyPrompt,
  extractAgySessionId,
  extractAgySuggestedCode,
  extractAgyTranscriptPath,
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  type AgyHookPayload,
  type HookPayload,
} from '../core/hookInput.ts';
import type { EnvironmentPlugin, HookTranscript } from './types.ts';

/**
 * Normalize this session's Antigravity transcript for the generic stop reconcile.
 * agy hands every hook a `transcriptPath` (its session JSONL), so we read that
 * directly; if it's absent we fall back to locating the conversation by the
 * payload's `conversationId`, else the newest brain dir. Captures the student's
 * prompts, the planner's replies, and (Antigravity's signature) its generated
 * PLANS / task lists. Returns null when none is on disk or it can't be parsed,
 * leaving Stop a no-op.
 */
function antigravityCliGetTranscript(raw: unknown, root: string): HookTranscript | null {
  const p = raw as AgyHookPayload | null;
  const sid = extractAgySessionId(p ?? {});
  const tp = extractAgyTranscriptPath(p ?? {});
  if (tp && existsSync(tp)) {
    try {
      return parseAntigravityCliTranscript(readFileSync(tp, 'utf8'), root, sid);
    } catch {
      /* fall through to disk discovery */
    }
  }
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
      // agy's PostToolUse payload is `{ toolCall:{name,args:{TargetFile,
      // CodeContent}}, conversationId, transcriptPath, workspacePaths }` (verified
      // live). Read those agy-specific fields, falling back to the Claude-shaped
      // extractors so a future/different payload still degrades gracefully.
      parse(raw) {
        const p = raw as AgyHookPayload & HookPayload;
        const edited = extractAgyEditedFiles(p);
        return {
          nativeSessionId: extractAgySessionId(p) ?? extractSessionId(p),
          prompt: extractAgyPrompt(p) ?? extractPrompt(p) ?? undefined,
          editedFiles: edited.length > 0 ? edited : extractEditedFiles(p),
          suggestedDiff: extractAgySuggestedCode(p) ?? extractSuggestedCode(p),
        };
      },
      // Antigravity's own dirs: ~/.gemini (shared config/transcripts) and the
      // workspace .agents/ dir (hooks + rules). Never snapshot edits to these.
      internalPaths: [/(^|[\\/])\.gemini([\\/]|$)/, /(^|[\\/])\.agents([\\/]|$)/],
      // Antigravity writes a per-conversation JSONL transcript under
      // ~/.gemini/antigravity-cli/brain; locate it (by session id, else newest)
      // and reconcile prompts/replies/plans from it at Stop.
      getTranscript: antigravityCliGetTranscript,
      // Antigravity writes the session's plan to brain/<conversationId>/plan.md.
      // Surface it so the report can link to the saved plan file.
      planFiles(raw) {
        const p = raw as AgyHookPayload & HookPayload;
        return antigravityCliPlanFiles(extractAgySessionId(p) ?? extractSessionId(p));
      },
    },
  },
};
