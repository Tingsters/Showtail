import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// The skill markdown is the single source of truth: it is committed under
// assets/ AND embedded into the compiled binary via this text import, so
// `showtail connect claude` is fully self-contained (no files to ship).
import SKILL_MD from '../../assets/claude-code/plugin/skills/showtail/SKILL.md' with { type: 'text' };
import {
  hasOurHooks,
  mergeHookEvents,
  unmergeHookEvents,
  type HookEvents,
} from './hookMerge.ts';
import { findRoot, readJson, writeJson } from './storage.ts';

export { SKILL_MD };

/**
 * The canonical hook configuration. This is the single source of truth for
 * both the settings.json merge and the committed plugin `hooks/hooks.json`
 * (a test asserts they stay in sync).
 */
export const HOOK_EVENTS: HookEvents = {
  SessionStart: [
    { hooks: [{ type: 'command', command: 'showtail hook session-start' }] },
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'showtail hook user-prompt' }] },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: 'showtail hook post-edit' }],
    },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop' }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: 'showtail hook session-end' }] }],
};

/** The exact JSON text of the plugin's `hooks/hooks.json` (for sync checks). */
export function pluginHooksJson(): string {
  return JSON.stringify({ hooks: HOOK_EVENTS }, null, 2) + '\n';
}

export type InstallScope = 'user' | 'project';

export interface SkillTarget {
  scope: InstallScope;
  /** The `.claude` directory we install into. */
  claudeDir: string;
  skillDir: string;
  skillFile: string;
  settingsFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user: ~/.claude
 *  - project: the nearest Showtail/project root (or cwd) /.claude
 */
export function resolveTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): SkillTarget {
  const base = scope === 'user' ? homedir() : (findRoot(cwd) ?? cwd);
  const claudeDir = join(base, '.claude');
  const skillDir = join(claudeDir, 'skills', 'showtail');
  return {
    scope,
    claudeDir,
    skillDir,
    skillFile: join(skillDir, 'SKILL.md'),
    settingsFile: join(claudeDir, 'settings.json'),
  };
}

/** Write the SKILL.md into the target. Returns the file path written. */
export function writeSkill(target: SkillTarget): string {
  mkdirSync(dirname(target.skillFile), { recursive: true });
  // SKILL_MD already ends with a newline; write it verbatim.
  writeFileSync(target.skillFile, SKILL_MD, 'utf8');
  return target.skillFile;
}

/**
 * Merge our hooks into a settings.json object, idempotently and without
 * clobbering the user's existing hooks. Returns the updated object.
 */
export function mergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  return mergeHookEvents(settings, HOOK_EVENTS);
}

/** Remove only our hooks from a settings.json object. Returns it updated. */
export function unmergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  return unmergeHookEvents(settings);
}

/** Install (or refresh) the hook config in the target's settings.json. */
export function installHooks(target: SkillTarget): string {
  const current = existsSync(target.settingsFile)
    ? readJson<Record<string, unknown>>(target.settingsFile)
    : {};
  writeJson(target.settingsFile, mergeHooks(current));
  return target.settingsFile;
}

/** Remove the hook config from the target's settings.json (if present). */
export function uninstallHooks(target: SkillTarget): boolean {
  if (!existsSync(target.settingsFile)) return false;
  const current = readJson<Record<string, unknown>>(target.settingsFile);
  writeJson(target.settingsFile, unmergeHooks(current));
  return true;
}

/** Remove the installed skill directory (if present). */
export function removeSkill(target: SkillTarget): boolean {
  if (!existsSync(target.skillDir)) return false;
  rmSync(target.skillDir, { recursive: true, force: true });
  return true;
}

/** Does this settings.json contain our auto-capture hooks? */
export function hooksInstalledAt(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  try {
    return hasOurHooks(readJson<Record<string, unknown>>(settingsFile));
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's auto-capture hooks are active for work in `cwd` — true if
 * they're installed at either project or user scope. The skill uses this (via
 * `showtail status --json`) to decide whether to capture prompts/edits manually.
 */
export function autoCaptureActive(cwd: string = process.cwd()): boolean {
  return (
    hooksInstalledAt(resolveTarget('project', cwd).settingsFile) ||
    hooksInstalledAt(resolveTarget('user', cwd).settingsFile)
  );
}
