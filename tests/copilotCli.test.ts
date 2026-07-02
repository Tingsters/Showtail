import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COPILOT_BODY,
  COPILOT_CLI_HOOK_EVENTS,
  copilotCliHooksInstalledAt,
  copilotCliInstructionsState,
  resolveCopilotCliTarget,
} from '../src/core/copilotCli.ts';
import { mergeHookEvents } from '../src/core/hookMerge.ts';
import {
  runCopilotCliInstall,
  runCopilotCliUninstall,
} from '../src/commands/copilotCli.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('copilot-cli install / uninstall', () => {
  test('install writes the instructions block + hooks file', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here.
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);

      expect(existsSync(target.instructionsFile)).toBe(true);
      const body = readFileSync(target.instructionsFile, 'utf8');
      expect(body).toContain('showtail:start');
      // The required Copilot `applyTo` frontmatter sits above the managed block.
      expect(body).toContain("applyTo: '**'");
      expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(true);

      // The four Copilot lifecycle events are present (Copilot's real camelCase
      // event names — not Claude's PascalCase), with the version envelope.
      const hooks = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(hooks.version).toBe(1);
      for (const event of [
        'sessionStart',
        'userPromptSubmitted',
        'postToolUse',
        'sessionEnd',
      ]) {
        expect(Array.isArray(hooks.hooks[event])).toBe(true);
      }

      await runCopilotCliUninstall({ cwd: dir });
      // Block was the only content, so the instructions file is removed; hooks emptied.
      expect(existsSync(target.instructionsFile)).toBe(false);
      expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate block or hook entries)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, cwd: dir });
      await runCopilotCliInstall({ project: true, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);

      const body = readFileSync(target.instructionsFile, 'utf8');
      expect(body.match(/showtail:start/g)?.length).toBe(1);

      const hooks = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const post = hooks.hooks.postToolUse as Array<{ hooks: { command: string }[] }>;
      const ours = post.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
      expect(ours).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks writes only the instructions, no hooks file', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);
      expect(existsSync(target.instructionsFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('uninstall round-trips on the dedicated instructions file', async () => {
    // The .instructions.md is a Showtail-dedicated file (only our block plus the
    // applyTo frontmatter we wrote). A clean uninstall removes it entirely rather
    // than leaving an orphan frontmatter-only file behind.
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveCopilotCliTarget('project', dir);

      await runCopilotCliInstall({ project: true, cwd: dir });
      expect(existsSync(target.instructionsFile)).toBe(true);
      expect(readFileSync(target.instructionsFile, 'utf8')).toContain('showtail:start');

      await runCopilotCliUninstall({ cwd: dir });
      expect(existsSync(target.instructionsFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('user content outside the block survives uninstall', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);

      // The student appends their own notes after our block.
      const withNotes =
        readFileSync(target.instructionsFile, 'utf8') + '\n# My own rules\n\nUse tabs.\n';
      writeFileSync(target.instructionsFile, withNotes);

      await runCopilotCliUninstall({ cwd: dir });
      // The file is kept (it has user content) and our block is gone.
      const cleaned = readFileSync(target.instructionsFile, 'utf8');
      expect(cleaned).toContain('# My own rules');
      expect(cleaned).toContain('Use tabs.');
      expect(cleaned).not.toContain('showtail:start');
    } finally {
      cleanup(dir);
    }
  });

  test('instructions state reflects an up-to-date install', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      const state = copilotCliInstructionsState(resolveCopilotCliTarget('project', dir));
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.userEdited).toBe(false);
      expect(state.updateAvailable).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('merging the hook events is idempotent', () => {
    const once = mergeHookEvents({ version: 1 }, COPILOT_CLI_HOOK_EVENTS);
    const twice = mergeHookEvents(once, COPILOT_CLI_HOOK_EVENTS);
    const post = (twice.hooks as Record<string, unknown[]>).postToolUse as Array<{
      hooks: { command: string }[];
    }>;
    const ours = post.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
    expect(ours).toHaveLength(1);
  });

  test('the instructions body is non-empty and mentions the tool', () => {
    expect(COPILOT_BODY.length).toBeGreaterThan(0);
    expect(COPILOT_BODY).toContain('GitHub Copilot CLI');
  });
});
