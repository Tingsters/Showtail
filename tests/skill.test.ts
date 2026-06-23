import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  HOOK_EVENTS,
  SKILL_MD,
  autoCaptureActive,
  hooksInstalledAt,
  installHooks,
  mergeHooks,
  removeSkill,
  resolveTarget,
  skillState,
  uninstallHooks,
  unmergeHooks,
  writeSkill,
} from '../src/core/skill.ts';
import {
  applyManagedBlock,
  parseBlock,
  splitFrontmatter,
  START_RE,
} from '../src/core/managedBlock.ts';
import { readJson } from '../src/core/storage.ts';
import { runSkillInstall, runSkillUninstall } from '../src/commands/skill.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('skill assets + install', () => {
  test('writeSkill keeps frontmatter on top and wraps the body in a marker', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      const file = writeSkill(target);
      expect(file.endsWith('SKILL.md')).toBe(true);

      const written = readFileSync(file, 'utf8');
      // Frontmatter must stay at the very top so Claude's loader reads it.
      expect(written.startsWith('---\n')).toBe(true);
      expect(written).toContain('name: showtail');
      // The body is wrapped in a fingerprinted managed block.
      expect(START_RE.test(written)).toBe(true);
      expect(written).toContain('<!-- showtail:end -->');
      expect(SKILL_MD).toContain('name: showtail');
    } finally {
      cleanup(dir);
    }
  });

  test('fresh install is up to date with no update available', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      writeSkill(target);
      const state = skillState(target);
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.userEdited).toBe(false);
      expect(state.updateAvailable).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('missing install reports not installed', () => {
    const dir = makeTempDir();
    try {
      const state = skillState(resolveTarget('project', dir));
      expect(state.installed).toBe(false);
      expect(state.updateAvailable).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('writeSkill is idempotent and round-trips', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      writeSkill(target);
      const first = readFileSync(target.skillFile, 'utf8');
      writeSkill(target);
      const second = readFileSync(target.skillFile, 'utf8');
      expect(second).toBe(first);
      expect(skillState(target).upToDate).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a stale install (older body) reports updateAvailable', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      mkdirSync(target.skillDir, { recursive: true });
      const { preamble } = splitFrontmatter(SKILL_MD);
      // Simulate an older shipped version: an untouched block with different text.
      applyManagedBlock(target.skillFile, 'OLD BODY TEXT', preamble, false);
      const state = skillState(target);
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(false);
      expect(state.userEdited).toBe(false);
      expect(state.updateAvailable).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('a user edit inside the block reports userEdited', () => {
    const dir = makeTempDir();
    try {
      const target = resolveTarget('project', dir);
      writeSkill(target);
      // Hand-edit the managed body without updating the sha stamp.
      const current = readFileSync(target.skillFile, 'utf8');
      const parsed = parseBlock(current)!;
      const tampered =
        current.slice(0, parsed.startIndex) +
        current.slice(parsed.startIndex).replace(parsed.inner, parsed.inner + '\n\nHAND EDIT');
      writeFileSync(target.skillFile, tampered, 'utf8');

      const state = skillState(target);
      expect(state.installed).toBe(true);
      expect(state.userEdited).toBe(true);
      // Same shipped version, so no newer update — only an edit.
      expect(state.updateAvailable).toBe(false);
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

  test('install enables hooks by default and writes skill + settings', async () => {
    const dir = makeTempDir();
    try {
      await runSkillInstall({ project: true, cwd: dir });
      const target = resolveTarget('project', dir);
      expect(existsSync(target.skillFile)).toBe(true);
      expect(hooksInstalledAt(target.settingsFile)).toBe(true);

      await runSkillUninstall({ cwd: dir });
      expect(existsSync(target.skillDir)).toBe(false);
      expect(hooksInstalledAt(target.settingsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install --no-hooks leaves settings.json untouched', async () => {
    const dir = makeTempDir();
    try {
      await runSkillInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveTarget('project', dir);
      expect(existsSync(target.skillFile)).toBe(true);
      expect(existsSync(target.settingsFile)).toBe(false);
      expect(hooksInstalledAt(target.settingsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('autoCaptureActive reflects project-scope hooks', () => {
    const dir = makeTempDir();
    try {
      // Installing project hooks must flip detection to true regardless of any
      // ambient user-scope state.
      installHooks(resolveTarget('project', dir));
      expect(autoCaptureActive(dir)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
