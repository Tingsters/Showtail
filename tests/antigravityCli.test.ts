import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_BODY,
  ANTIGRAVITY_BLOCK_NAME,
  antigravityCliHooksInstalledAt,
  antigravityCliInstructionsState,
  installAntigravityCliHooks,
  resolveAntigravityCliTarget,
  uninstallAntigravityCliHooks,
  writeAntigravityCliInstructions,
} from '../src/core/antigravityCli.ts';
import { writeJson } from '../src/core/storage.ts';
import {
  runAntigravityCliInstall,
  runAntigravityCliUninstall,
} from '../src/commands/antigravityCli.ts';
import { cleanup, makeTempDir } from './helpers.ts';
import { antigravityCliPlugin } from '../src/plugins/antigravity-cli.ts';

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

      // agy's real schema: a `showtail-cli` named block with `enabled` + its real events.
      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(settings[ANTIGRAVITY_BLOCK_NAME].enabled).toBe(true);
      for (const event of ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop']) {
        expect(Array.isArray(settings[ANTIGRAVITY_BLOCK_NAME][event])).toBe(true);
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
      // One `showtail-cli` block, one PostToolUse handler — no duplication.
      expect(
        Object.keys(settings).filter((k) => k === ANTIGRAVITY_BLOCK_NAME),
      ).toHaveLength(1);
      expect(settings[ANTIGRAVITY_BLOCK_NAME].PostToolUse).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('--no-hooks writes only instructions, no hooks.json', async () => {
    const dir = makeTempDir();
    const lines: string[] = [];
    const realLog = console.log;
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      console.log = (...args: unknown[]) => void lines.push(args.join(' '));
      await runAntigravityCliInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveAntigravityCliTarget('project', dir);
      expect(existsSync(target.contextFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(antigravityCliHooksInstalledAt(target.hooksFile)).toBe(false);

      const output = lines.join('\n');
      expect(output).toContain('routine prompts');
      expect(output).toContain('will not be captured automatically');
      expect(output).toContain('restore hands-free capture');
      expect(output).not.toContain('teach Antigravity CLI to log prompts');
    } finally {
      console.log = realLog;
      cleanup(dir);
    }
  });

  test('--no-hooks removes hooks from an earlier connect', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveAntigravityCliTarget('project', dir);
      await runAntigravityCliInstall({ project: true, cwd: dir });
      expect(antigravityCliHooksInstalledAt(target.hooksFile)).toBe(true);

      await runAntigravityCliInstall({ project: true, hooks: false, cwd: dir });

      expect(existsSync(target.contextFile)).toBe(true);
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
      // or AGENTS.md (codex) at the project root.
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

  test('user-scope instructions without hooks report a connected manual integration', () => {
    const dir = makeTempDir();
    const gemini = makeTempDir();
    const previous = process.env.GEMINI_HOME;
    try {
      process.env.GEMINI_HOME = gemini;
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      writeAntigravityCliInstructions(resolveAntigravityCliTarget('user', dir));

      expect(antigravityCliPlugin.connect!.status(dir)).toEqual({
        connected: true,
        hooksActive: false,
        updateAvailable: false,
      });
    } finally {
      if (previous === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previous;
      cleanup(dir);
      cleanup(gemini);
    }
  });

  test('install/uninstall preserve a co-existing user hook block', () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveAntigravityCliTarget('project', dir);
      // A user already has their own block in hooks.json.
      mkdirSync(join(dir, '.agents'), { recursive: true });
      writeJson(target.hooksFile, {
        'my-safety-gate': { enabled: true, PreToolUse: [] },
      });

      installAntigravityCliHooks(target);
      let blocks = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(blocks['my-safety-gate']).toBeDefined(); // ours sits alongside theirs
      expect(blocks[ANTIGRAVITY_BLOCK_NAME]).toBeDefined();

      uninstallAntigravityCliHooks(target);
      blocks = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(blocks[ANTIGRAVITY_BLOCK_NAME]).toBeUndefined(); // only ours removed
      expect(blocks['my-safety-gate']).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test('the instructions body is non-empty and mentions the tool', () => {
    expect(AGY_BODY.length).toBeGreaterThan(0);
    expect(AGY_BODY).toContain('Antigravity CLI');
  });
});
