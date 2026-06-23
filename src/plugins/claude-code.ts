/**
 * Claude Code — the only environment with both capabilities: live capture
 * (skill + hooks in `.claude/`) and transcript import (`.jsonl` sessions on
 * disk). All Claude-specific install/state logic stays in core/skill.ts and
 * commands/skill.ts; this module just exposes it through the plugin contract.
 */
import { existsSync } from 'node:fs';
import { runSkillInstall, runSkillUninstall } from '../commands/skill.ts';
import { runImportClaudeCode } from '../commands/importClaude.ts';
import {
  autoCaptureActive,
  installHooks,
  resolveTarget,
  skillState,
  writeSkill,
} from '../core/skill.ts';
import { commandOnPath, homeDirExists } from '../core/detect.ts';
import { readTranscriptFile } from '../core/claudeCode.ts';
import {
  extractEditedFiles,
  extractPrompt,
  extractSessionId,
  extractSuggestedCode,
  type HookPayload,
} from '../core/hookInput.ts';
import type { DiscoveredPlanFile, EnvironmentPlugin } from './types.ts';

/** Is the skill installed at either scope? */
function skillInstalled(cwd?: string): boolean {
  return (
    existsSync(resolveTarget('project', cwd).skillFile) ||
    existsSync(resolveTarget('user', cwd).skillFile)
  );
}

export const claudeCodePlugin: EnvironmentPlugin = {
  id: 'claude-code',
  cliName: 'claude',
  aliases: ['claude-code'],
  label: 'Claude Code',

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
        description: 'skip auto-capture hooks; log prompts/edits yourself via the skill',
      },
      {
        name: 'force',
        flag: '--force',
        description: 'overwrite existing instructions/skill (take the latest)',
      },
    ],
    applicableFlags: ['user', 'project', 'hooks', 'force'],

    detect: () => commandOnPath('claude') || homeDirExists('.claude'),

    autoConnect(cwd) {
      const target = resolveTarget('user', cwd);
      writeSkill(target);
      installHooks(target);
      return { hooks: true };
    },

    install: (opts) =>
      runSkillInstall({
        user: opts.user,
        project: opts.project,
        hooks: opts.hooks,
        force: opts.force,
        cwd: opts.cwd,
      }),

    uninstall: (opts) => runSkillUninstall({ user: opts.user, cwd: opts.cwd }),

    status(cwd) {
      const hooksActive = autoCaptureActive(cwd);
      // Prefer the project-scope skill, falling back to user scope, so status
      // reflects whichever install is actually present (mirrors codex).
      const project = skillState(resolveTarget('project', cwd));
      const state = project.installed ? project : skillState(resolveTarget('user', cwd));
      return {
        connected: skillInstalled(cwd) || hooksActive,
        hooksActive,
        updateAvailable: state.installed ? state.updateAvailable : undefined,
      };
    },

    hooks: {
      parse(raw) {
        const p = raw as HookPayload;
        return {
          nativeSessionId: extractSessionId(p),
          prompt: extractPrompt(p) ?? undefined,
          editedFiles: extractEditedFiles(p), // Edit/Write/MultiEdit set file_path
          suggestedDiff: extractSuggestedCode(p),
        };
      },
      // .claude is metadata; .claude/worktrees holds real isolated checkouts.
      internalPaths: [/(^|[\\/])\.claude([\\/]|$)/],
      includePaths: [/(^|[\\/])\.claude[\\/]worktrees[\\/]/],
      getTranscript(raw, root) {
        const tp = (raw as HookPayload)?.transcript_path;
        if (typeof tp !== 'string' || !existsSync(tp)) return null;
        try {
          return readTranscriptFile(tp, root);
        } catch {
          return null; // Unknown/unsupported transcript format — nothing to capture.
        }
      },
      // Claude Code writes plan files to ~/.claude/plans/<slug>.md, but the slug
      // has no reliable mapping back to a session id, so we can't safely pick the
      // right file here. Claude plans are instead materialized from the
      // ExitPlanMode plan text already on the transcript (see the stop reconcile),
      // which is reliable. Hence: an explicit no-op.
      planFiles(): DiscoveredPlanFile[] {
        return [];
      },
    },
  },

  import: {
    command: 'claude',
    aliases: ['claude-code'],
    description:
      'Import an existing Claude Code session transcript from disk into your trail.\n' +
      "With no target, opens an interactive picker of this project's sessions " +
      '(choose one or several); --list prints the same list non-interactively.',
    shape: 'transcript',
    run: (source, opts) =>
      runImportClaudeCode(source, {
        list: opts.list,
        withResponses: opts.withResponses,
        file: opts.file,
        session: opts.session,
        cwd: opts.cwd,
      }),
  },
};
