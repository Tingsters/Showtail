import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// The skill markdown is the single source of truth: it is committed under
// assets/ AND embedded into the compiled binary via this text import, so
// `showtail skill install` is fully self-contained (no files to ship).
import SKILL_MD from '../../assets/claude-code/plugin/skills/showtail/SKILL.md' with { type: 'text' };
import { findRoot, readJson, writeJson } from './storage.ts';

export { SKILL_MD };

/** A single Claude Code hook command entry. */
interface HookCommand {
  type: 'command';
  command: string;
}

/** A matcher group: optional `matcher` plus the commands to run. */
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** Map of hook event name -> matcher groups. */
type HookEvents = Record<string, HookGroup[]>;

/** Marker used to recognize (and cleanly remove) the hooks we install. */
const HOOK_MARKER = 'showtail hook';

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

/** Is this matcher group one that we installed? */
function isOurGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER),
  );
}

/**
 * Merge our hooks into a settings.json object, idempotently and without
 * clobbering the user's existing hooks. Returns the updated object.
 */
export function mergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  const hooks: HookEvents =
    next.hooks && typeof next.hooks === 'object' ? { ...(next.hooks as HookEvents) } : {};

  for (const [event, groups] of Object.entries(HOOK_EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event]! : [];
    // Drop any prior Showtail entries so re-running install never duplicates.
    const preserved = existing.filter((g) => !isOurGroup(g));
    hooks[event] = [...preserved, ...groups];
  }

  next.hooks = hooks;
  return next;
}

/** Remove only our hooks from a settings.json object. Returns it updated. */
export function unmergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks: HookEvents = { ...(next.hooks as HookEvents) };

  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const kept = groups.filter((g) => !isOurGroup(g));
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return next;
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
