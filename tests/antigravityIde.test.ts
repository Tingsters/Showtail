import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_IDE_BODY,
  ANTIGRAVITY_IDE_HOOK_EVENTS,
  ANTIGRAVITY_IDE_HOOK_NAMESPACE,
  antigravityIdeAutoCaptureActive,
  antigravityIdeHooksInstalledAt,
  antigravityIdeInstructionsState,
  resolveAntigravityIdeTarget,
} from '../src/core/antigravityIde.ts';
import { mergeNamedHooks } from '../src/core/namedHooks.ts';
import { writeJson } from '../src/core/storage.ts';
import {
  runAntigravityIdeInstall,
  runAntigravityIdeUninstall,
} from '../src/commands/antigravityIde.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/**
 * The IDE reads its hooks from the GLOBAL ~/.gemini/config/hooks.json. Point
 * `geminiHome()` at a temp dir via GEMINI_HOME so install/uninstall never touches
 * the real home directory.
 */
const PREV_GEMINI_HOME = process.env.GEMINI_HOME;
let geminiHomeDir: string;

beforeEach(() => {
  geminiHomeDir = join(makeTempDir(), '.gemini');
  process.env.GEMINI_HOME = geminiHomeDir;
});

afterEach(() => {
  if (PREV_GEMINI_HOME === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = PREV_GEMINI_HOME;
});

describe('antigravity-ide install / uninstall', () => {
  test('install writes instructions block + the global named-bundle hooks.json', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      const target = resolveAntigravityIdeTarget('project', dir);

      expect(existsSync(target.contextFile)).toBe(true);
      expect(readFileSync(target.contextFile, 'utf8')).toContain('showtail:start');
      // Hooks go to the global file under GEMINI_HOME, not the project dir.
      expect(target.hooksFile).toBe(join(geminiHomeDir, 'config', 'hooks.json'));
      expect(antigravityIdeHooksInstalledAt(target.hooksFile)).toBe(true);

      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const bundle = settings[ANTIGRAVITY_IDE_HOOK_NAMESPACE];
      expect(bundle.enabled).toBe(true);
      // Only the events the IDE language server recognizes.
      for (const event of ['PreInvocation', 'PostToolUse', 'Stop']) {
        expect(Array.isArray(bundle[event])).toBe(true);
      }

      await runAntigravityIdeUninstall({ cwd: dir });
      expect(existsSync(target.contextFile)).toBe(false);
      expect(antigravityIdeHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate block or bundle)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      const target = resolveAntigravityIdeTarget('project', dir);

      const context = readFileSync(target.contextFile, 'utf8');
      expect(context.match(/showtail:start/g)?.length).toBe(1);

      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const postEdit = settings[ANTIGRAVITY_IDE_HOOK_NAMESPACE].PostToolUse as Array<{
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
      await runAntigravityIdeInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveAntigravityIdeTarget('project', dir);
      expect(existsSync(target.contextFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(antigravityIdeAutoCaptureActive(dir)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('preserves a foreign named bundle in the same hooks.json', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveAntigravityIdeTarget('project', dir);
      // A user's pre-existing, unrelated named bundle must survive connect/disconnect.
      const foreign = { 'their-tool': { enabled: true, Stop: [{ hooks: [] }] } };
      writeJson(target.hooksFile, foreign);

      await runAntigravityIdeInstall({ project: true, cwd: dir });
      let settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(settings['their-tool']).toBeDefined();
      expect(settings[ANTIGRAVITY_IDE_HOOK_NAMESPACE]).toBeDefined();

      await runAntigravityIdeUninstall({ cwd: dir });
      settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      expect(settings['their-tool']).toBeDefined(); // untouched
      expect(settings[ANTIGRAVITY_IDE_HOOK_NAMESPACE]).toBeUndefined(); // ours removed
    } finally {
      cleanup(dir);
    }
  });

  test('does not collide with GEMINI.md or AGENTS.md', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      expect(existsSync(join(dir, 'GEMINI.md'))).toBe(false);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
      const target = resolveAntigravityIdeTarget('project', dir);
      expect(target.contextFile).toContain('.agents');
      expect(target.contextFile).toContain('AGY-IDE.showtail.md');
    } finally {
      cleanup(dir);
    }
  });

  test('instructions state reflects an up-to-date install', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, hooks: false, cwd: dir });
      const state = antigravityIdeInstructionsState(
        resolveAntigravityIdeTarget('project', dir),
      );
      expect(state.installed).toBe(true);
      expect(state.upToDate).toBe(true);
      expect(state.userEdited).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('merging the named bundle is idempotent', () => {
    const once = mergeNamedHooks(
      {},
      ANTIGRAVITY_IDE_HOOK_NAMESPACE,
      ANTIGRAVITY_IDE_HOOK_EVENTS,
    );
    const twice = mergeNamedHooks(
      once,
      ANTIGRAVITY_IDE_HOOK_NAMESPACE,
      ANTIGRAVITY_IDE_HOOK_EVENTS,
    );
    const post = (twice[ANTIGRAVITY_IDE_HOOK_NAMESPACE] as Record<string, unknown[]>)
      .PostToolUse as Array<{ hooks: { command: string }[] }>;
    const ours = post.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
    expect(ours).toHaveLength(1);
  });

  test('the instructions body is non-empty and mentions the tool', () => {
    expect(AGY_IDE_BODY.length).toBeGreaterThan(0);
    expect(AGY_IDE_BODY).toContain('Antigravity IDE');
  });
});
