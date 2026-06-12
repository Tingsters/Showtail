import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  HOOK_EVENTS,
  SKILL_MD,
  installHooks,
  mergeHooks,
  removeSkill,
  resolveTarget,
  uninstallHooks,
  unmergeHooks,
  writeSkill,
} from '../src/core/skill.ts';
import { readJson } from '../src/core/storage.ts';
import { runSkillInstall, runSkillUninstall } from '../src/commands/skill.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('skill assets + install', () => {
  test('writeSkill writes the embedded SKILL.md verbatim', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      const file = writeSkill(target);
      expect(file.endsWith('SKILL.md')).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(SKILL_MD);
      expect(SKILL_MD).toContain('name: showtail');
    } finally {
      cleanup(dir);
    }
  });

  test('mergeHooks adds all four events to empty settings', () => {
    const merged = mergeHooks({});
    const hooks = merged.hooks as Record<string, unknown[]>;
    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(Array.isArray(hooks[event])).toBe(true);
    }
  });

  test('mergeHooks preserves unrelated settings and existing user hooks', () => {
    const existing = {
      theme: 'dark',
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    };
    const merged = mergeHooks(existing);
    expect(merged.theme).toBe('dark');
    const post = (merged.hooks as any).PostToolUse as any[];
    // user's Bash hook preserved + our Edit|Write|MultiEdit entry appended
    expect(post.some((g) => g.matcher === 'Bash')).toBe(true);
    expect(post.some((g) => g.hooks?.[0]?.command?.includes('showtail hook'))).toBe(true);
  });

  test('mergeHooks is idempotent (no duplicate Showtail entries)', () => {
    const once = mergeHooks({});
    const twice = mergeHooks(once);
    const post = (twice.hooks as any).PostToolUse as any[];
    const ours = post.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
    expect(ours).toHaveLength(1);
  });

  test('unmergeHooks removes only Showtail entries', () => {
    const withUser = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    };
    const merged = mergeHooks(withUser);
    const cleaned = unmergeHooks(merged) as Record<string, any>;
    const post = cleaned.hooks.PostToolUse;
    expect(post.some((g: any) => g.matcher === 'Bash')).toBe(true);
    expect(post.some((g: any) => g.hooks?.[0]?.command?.includes('showtail hook'))).toBe(
      false,
    );
    // Events that only had our entry are dropped entirely.
    expect(cleaned.hooks.UserPromptSubmit).toBeUndefined();
  });

  test('installHooks then uninstallHooks round-trips settings.json on disk', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      installHooks(target);
      expect(existsSync(target.settingsFile)).toBe(true);
      const after = readJson<Record<string, any>>(target.settingsFile);
      expect(after.hooks.SessionStart).toBeDefined();

      uninstallHooks(target);
      const cleaned = readJson<Record<string, any>>(target.settingsFile);
      expect(cleaned.hooks).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  test('full install command writes skill and (with hooks) settings', async () => {
    const dir = makeTempDir();
    try {
      await runSkillInstall({ project: true, hooks: true, cwd: dir });
      const target = resolveTarget('project', dir);
      expect(existsSync(target.skillFile)).toBe(true);
      expect(existsSync(target.settingsFile)).toBe(true);

      await runSkillUninstall({ cwd: dir });
      expect(existsSync(target.skillDir)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install without hooks leaves settings.json untouched', async () => {
    const dir = makeTempDir();
    try {
      await runSkillInstall({ project: true, cwd: dir });
      const target = resolveTarget('project', dir);
      expect(existsSync(target.skillFile)).toBe(true);
      expect(existsSync(target.settingsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
