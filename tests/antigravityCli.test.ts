import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_BODY,
  ANTIGRAVITY_CLI_HOOK_EVENTS,
  antigravityCliHooksInstalledAt,
  antigravityCliInstructionsState,
  resolveAntigravityCliTarget,
} from '../src/core/antigravityCli.ts';
import { mergeHookEvents } from '../src/core/hookMerge.ts';
import {
  runAntigravityCliInstall,
  runAntigravityCliUninstall,
} from '../src/commands/antigravityCli.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('antigravity-cli install / uninstall', () => {
  test('install writes instructions block + hooks.json', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here.
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityCliInstall({ project: true, cwd: dir });
      const target = resolveAntigravityCliTarget('project', dir);

      expect(existsSync(target.contextFile)).toBe(true);
      expect(readFileSync(target.contextFile, 'utf8')).toContain('showtail:start');
      expect(antigravityCliHooksInstalledAt(target.hooksFile)).toBe(true);

      // The four Antigravity lifecycle events are present.
      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
        expect(Array.isArray(settings.hooks[event])).toBe(true);
      }

      await runAntigravityCliUninstall({ cwd: dir });
      // Block was the only content, so the instructions file is removed; hooks emptied.
      expect(existsSync(target.contextFile)).toBe(false);
      expect(antigravityCliHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate block or hook entries)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityCliInstall({ project: true, cwd: dir });
      await runAntigravityCliInstall({ project: true, cwd: dir });
      const target = resolveAntigravityCliTarget('project', dir);

      const context = readFileSync(target.contextFile, 'utf8');
      expect(context.match(/showtail:start/g)?.length).toBe(1);

      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const postEdit = settings.hooks.PostToolUse as Array<{
        hooks: { command: string }[];
      }>;
      const ours = postEdit.filter((g) =>
        g.hooks?.[0]?.command?.includes('showtail hook'),
      );
      expect(ours).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks writes only instructions, no hooks.json', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveAntigravityCliTarget('project', dir);
      expect(existsSync(target.contextFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(antigravityCliHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('does not collide with GEMINI.md or AGENTS.md', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityCliInstall({ project: true, cwd: dir });
      // The dedicated rules file must live in .agents/, NOT the shared GEMINI.md
      // (gemini-cli) or AGENTS.md (codex) at the project root.
      expect(existsSync(join(dir, 'GEMINI.md'))).toBe(false);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
      const target = resolveAntigravityCliTarget('project', dir);
      expect(target.contextFile).toContain('.agents');
      expect(target.hooksFile).toContain('.agents');
    } finally {
      cleanup(dir);
    }
  });

  test('instructions state reflects an up-to-date install', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityCliInstall({ project: true, hooks: false, cwd: dir });
      const state = antigravityCliInstructionsState(
        resolveAntigravityCliTarget('project', dir),
      );
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.userEdited).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('merging the hook events is idempotent', () => {
    const once = mergeHookEvents({}, ANTIGRAVITY_CLI_HOOK_EVENTS);
    const twice = mergeHookEvents(once, ANTIGRAVITY_CLI_HOOK_EVENTS);
    const hooks = (twice.hooks as Record<string, unknown[]>).PostToolUse as Array<{
      hooks: { command: string }[];
    }>;
    const ours = hooks.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
    expect(ours).toHaveLength(1);
  });

  test('the instructions body is non-empty and mentions the tool', () => {
    expect(AGY_BODY.length).toBeGreaterThan(0);
    expect(AGY_BODY).toContain('Antigravity CLI');
  });
});
