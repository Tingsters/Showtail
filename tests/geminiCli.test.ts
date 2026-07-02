import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GEMINI_BODY,
  GEMINI_CLI_HOOK_EVENTS,
  geminiCliHooksInstalledAt,
  geminiCliInstructionsState,
  resolveGeminiCliTarget,
} from '../src/core/geminiCli.ts';
import { mergeHookEvents } from '../src/core/hookMerge.ts';
import { runGeminiCliInstall, runGeminiCliUninstall } from '../src/commands/geminiCli.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('gemini-cli install / uninstall', () => {
  test('install writes GEMINI.md block + settings.json hooks', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here.
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runGeminiCliInstall({ project: true, cwd: dir });
      const target = resolveGeminiCliTarget('project', dir);

      expect(existsSync(target.contextFile)).toBe(true);
      expect(readFileSync(target.contextFile, 'utf8')).toContain('showtail:start');
      expect(geminiCliHooksInstalledAt(target.settingsFile)).toBe(true);

      // The four Gemini lifecycle events are present.
      const settings = JSON.parse(readFileSync(target.settingsFile, 'utf8'));
      for (const event of ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent']) {
        expect(Array.isArray(settings.hooks[event])).toBe(true);
      }

      await runGeminiCliUninstall({ cwd: dir });
      // Block was the only content, so GEMINI.md is removed; hooks emptied.
      expect(existsSync(target.contextFile)).toBe(false);
      expect(geminiCliHooksInstalledAt(target.settingsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate block or hook entries)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runGeminiCliInstall({ project: true, cwd: dir });
      await runGeminiCliInstall({ project: true, cwd: dir });
      const target = resolveGeminiCliTarget('project', dir);

      const context = readFileSync(target.contextFile, 'utf8');
      expect(context.match(/showtail:start/g)?.length).toBe(1);

      const settings = JSON.parse(readFileSync(target.settingsFile, 'utf8'));
      const afterTool = settings.hooks.AfterTool as Array<{
        hooks: { command: string }[];
      }>;
      const ours = afterTool.filter((g) =>
        g.hooks?.[0]?.command?.includes('showtail hook'),
      );
      expect(ours).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks writes only GEMINI.md, no settings.json', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runGeminiCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveGeminiCliTarget('project', dir);
      expect(existsSync(target.contextFile)).toBe(true);
      expect(existsSync(target.settingsFile)).toBe(false);
      expect(geminiCliHooksInstalledAt(target.settingsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('instructions state reflects an up-to-date install', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runGeminiCliInstall({ project: true, hooks: false, cwd: dir });
      const state = geminiCliInstructionsState(resolveGeminiCliTarget('project', dir));
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.userEdited).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('merging the hook events is idempotent', () => {
    const once = mergeHookEvents({}, GEMINI_CLI_HOOK_EVENTS);
    const twice = mergeHookEvents(once, GEMINI_CLI_HOOK_EVENTS);
    const hooks = (twice.hooks as Record<string, unknown[]>).AfterTool as Array<{
      hooks: { command: string }[];
    }>;
    const ours = hooks.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
    expect(ours).toHaveLength(1);
  });

  test('the instructions body is non-empty and mentions the tool', () => {
    expect(GEMINI_BODY.length).toBeGreaterThan(0);
    expect(GEMINI_BODY).toContain('Gemini CLI');
  });
});
