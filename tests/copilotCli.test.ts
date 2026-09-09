import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COPILOT_BODY,
  COPILOT_CLI_HOOK_EVENTS,
  copilotCliAutoCaptureActive,
  copilotCliHooksInstalledAt,
  findCopilotCliExecutable,
  copilotCliInstructionsState,
  resolveCopilotCliTarget,
} from '../src/core/copilotCli.ts';
import { mergeHookEvents } from '../src/core/hookMerge.ts';
import { blockFor, parseBlock } from '../src/core/managedBlock.ts';
import {
  runCopilotCliInstall,
  runCopilotCliUninstall,
} from '../src/commands/copilotCli.ts';
import { runCopilotInstall } from '../src/commands/copilot.ts';
import { copilotCliPlugin } from '../src/plugins/copilot-cli.ts';
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

  test('--no-hooks removes existing hooks at the selected scope', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);
      expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(true);

      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      expect(existsSync(target.instructionsFile)).toBe(true);
      expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks leaves automatic capture active when the other scope has hooks', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ user: true, cwd: dir });
      await runCopilotCliInstall({ project: true, cwd: dir });
      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      expect(copilotCliAutoCaptureActive(dir)).toBe(true);
      expect(
        copilotCliHooksInstalledAt(resolveCopilotCliTarget('user', dir).hooksFile),
      ).toBe(true);
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
    expect(COPILOT_BODY).toContain('Copilot CLI');
  });

  test('VS Code-only setup does not create Copilot CLI assets', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotInstall({ cwd: dir, extension: false });

      for (const scope of ['user', 'project'] as const) {
        const target = resolveCopilotCliTarget(scope, dir);
        expect(existsSync(target.instructionsFile)).toBe(false);
        expect(copilotCliHooksInstalledAt(target.hooksFile)).toBe(false);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('VS Code setup refreshes existing CLI blocks but preserves edited ones', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);
      const current = readFileSync(target.instructionsFile, 'utf8');
      const parsed = parseBlock(current)!;
      const stale =
        current.slice(0, parsed.startIndex) +
        blockFor('# Old Showtail CLI instructions') +
        current.slice(parsed.endIndex);
      writeFileSync(target.instructionsFile, stale);

      await runCopilotInstall({ cwd: dir, extension: false });
      expect(copilotCliInstructionsState(target).upToDate).toBe(true);

      const updated = readFileSync(target.instructionsFile, 'utf8');
      writeFileSync(
        target.instructionsFile,
        updated.replace('Copilot CLI lifecycle hooks own', 'My customized hooks own'),
      );
      const edited = readFileSync(target.instructionsFile, 'utf8');
      await runCopilotInstall({ cwd: dir, extension: false });
      expect(readFileSync(target.instructionsFile, 'utf8')).toBe(edited);
      expect(copilotCliInstructionsState(target).userEdited).toBe(true);

      await runCopilotInstall({ cwd: dir, extension: false, force: true });
      expect(copilotCliInstructionsState(target).upToDate).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('CLI auto-connect refreshes an existing project instruction block', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveCopilotCliTarget('project', dir);
      const current = readFileSync(target.instructionsFile, 'utf8');
      const parsed = parseBlock(current)!;
      writeFileSync(
        target.instructionsFile,
        current.slice(0, parsed.startIndex) +
          blockFor('# Old Showtail CLI instructions') +
          current.slice(parsed.endIndex),
      );

      copilotCliPlugin.connect!.autoConnect!(dir);
      expect(copilotCliInstructionsState(target).upToDate).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('copilot-cli detection and hook disable state', () => {
  const saved = {
    cli: process.env.SHOWTAIL_COPILOT_CLI,
    path: process.env.PATH,
    local: process.env.LOCALAPPDATA,
    roaming: process.env.APPDATA,
    home: process.env.COPILOT_HOME,
  };

  afterEach(() => {
    for (const [name, key] of [
      ['cli', 'SHOWTAIL_COPILOT_CLI'],
      ['path', 'PATH'],
      ['local', 'LOCALAPPDATA'],
      ['roaming', 'APPDATA'],
      ['home', 'COPILOT_HOME'],
    ] as const) {
      const value = saved[name];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('a .copilot directory alone is not installation evidence', () => {
    const dir = makeTempDir();
    try {
      process.env.COPILOT_HOME = dir;
      process.env.SHOWTAIL_COPILOT_CLI = join(dir, 'missing-copilot');
      expect(findCopilotCliExecutable()).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  test('an override or PATH executable detects the standalone CLI', () => {
    const dir = makeTempDir();
    try {
      const override = join(dir, platform() === 'win32' ? 'copilot.exe' : 'copilot');
      writeFileSync(override, '');
      process.env.SHOWTAIL_COPILOT_CLI = override;
      expect(findCopilotCliExecutable()).toBe(override);

      delete process.env.SHOWTAIL_COPILOT_CLI;
      process.env.PATH = dir;
      expect(findCopilotCliExecutable()).toBe('copilot');
    } finally {
      cleanup(dir);
    }
  });

  test('a WinGet package is detected even when copilot is not on PATH', () => {
    if (platform() !== 'win32') return;
    const dir = makeTempDir();
    try {
      delete process.env.SHOWTAIL_COPILOT_CLI;
      process.env.PATH = '';
      process.env.LOCALAPPDATA = dir;
      process.env.APPDATA = join(dir, 'roaming');
      const exe = join(
        dir,
        'Microsoft',
        'WinGet',
        'Packages',
        'GitHub.Copilot_test',
        'copilot.exe',
      );
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, '');
      expect(findCopilotCliExecutable()).toBe(exe);
    } finally {
      cleanup(dir);
    }
  });

  test('disableAllHooks makes auto-capture inactive even when hooks exist', async () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      process.env.COPILOT_HOME = home;
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCopilotCliInstall({ project: true, cwd: dir });
      expect(copilotCliAutoCaptureActive(dir)).toBe(true);

      writeFileSync(
        join(home, 'config.json'),
        '// Copilot user settings\n{ "disableAllHooks": true }\n',
      );
      expect(copilotCliAutoCaptureActive(dir)).toBe(false);
    } finally {
      cleanup(home);
      cleanup(dir);
    }
  });
});
