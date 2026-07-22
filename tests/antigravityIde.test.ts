import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGY_IDE_BODY,
  ANTIGRAVITY_IDE_HOOK_EVENTS,
  ANTIGRAVITY_IDE_HOOK_NAMESPACE,
  antigravityIdeAutoCaptureActive,
  antigravityIdeHooksInstalledAt,
  antigravityIdeInstalledOnHost,
  antigravityIdeInstructionsState,
  installAntigravityIdeHooks,
  resolveAntigravityIdeTarget,
  uninstallAntigravityIdeHooks,
} from '../src/core/antigravityIde.ts';
import { antigravityIdePlugin } from '../src/plugins/antigravity-ide.ts';
import {
  ANTIGRAVITY_BLOCK_NAME,
  installAntigravityCliHooks,
  uninstallAntigravityCliHooks,
} from '../src/core/antigravityCli.ts';
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
  test('default install writes instructions only — never the (dead) hooks.json', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      const target = resolveAntigravityIdeTarget('project', dir);

      expect(existsSync(target.contextFile)).toBe(true);
      expect(readFileSync(target.contextFile, 'utf8')).toContain('showtail:start');
      // The IDE's lifecycle hooks are dead (only PostToolUse fires); connect must
      // NOT write the global hooks.json — capture rides on the VS Code extension.
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(antigravityIdeAutoCaptureActive(dir)).toBe(false);

      await runAntigravityIdeUninstall({ cwd: dir });
      expect(existsSync(target.contextFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate instructions block)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      await runAntigravityIdeInstall({ project: true, cwd: dir });
      const target = resolveAntigravityIdeTarget('project', dir);
      const context = readFileSync(target.contextFile, 'utf8');
      expect(context.match(/showtail:start/g)?.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  // The named-hooks machinery stays in core (used to clean up legacy installs and
  // available behind the scenes); exercise it directly rather than via connect,
  // which no longer writes hooks for this IDE.
  test('the named-bundle hook machinery writes the IDE-recognized events', () => {
    const dir = makeTempDir();
    try {
      const target = resolveAntigravityIdeTarget('project', dir);
      installAntigravityIdeHooks(target);
      expect(target.hooksFile).toBe(join(geminiHomeDir, 'config', 'hooks.json'));
      expect(antigravityIdeHooksInstalledAt(target.hooksFile)).toBe(true);

      const settings = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const bundle = settings[ANTIGRAVITY_IDE_HOOK_NAMESPACE];
      expect(bundle.enabled).toBe(true);
      for (const event of ['PreInvocation', 'PostToolUse', 'Stop']) {
        expect(Array.isArray(bundle[event])).toBe(true);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('disconnect removes legacy hooks while preserving a foreign named bundle', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveAntigravityIdeTarget('project', dir);
      // A user's pre-existing, unrelated named bundle must survive disconnect, and
      // a hooks bundle left by an older Showtail must be cleaned up.
      const foreign = { 'their-tool': { enabled: true, Stop: [{ hooks: [] }] } };
      writeJson(target.hooksFile, foreign);
      installAntigravityIdeHooks(target);

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

  test('CLI and IDE bundles coexist in the shared hooks.json; disconnecting one preserves the other', () => {
    // In reality (GEMINI_HOME unset) both tools resolve the SAME global file
    // ~/.gemini/config/hooks.json. Point a CLI target at the IDE's shared file so
    // both bundles land in one hooks.json, then verify each disconnect removes ONLY
    // its own key. Regression for the old bug where both owned `showtail`, so
    // `disconnect antigravity-ide` silently deleted the CLI's capture hooks.
    const ideTarget = resolveAntigravityIdeTarget('user');
    const sharedHooks = ideTarget.hooksFile;
    const cliTarget = {
      scope: 'user' as const,
      hooksFile: sharedHooks,
      contextFile: join(geminiHomeDir, 'antigravity-cli', 'AGY.showtail.md'),
    };

    installAntigravityCliHooks(cliTarget);
    installAntigravityIdeHooks(ideTarget);
    let cfg = JSON.parse(readFileSync(sharedHooks, 'utf8'));
    expect(cfg[ANTIGRAVITY_BLOCK_NAME]).toBeDefined(); // showtail-cli
    expect(cfg[ANTIGRAVITY_IDE_HOOK_NAMESPACE]).toBeDefined(); // showtail-ide
    expect(ANTIGRAVITY_BLOCK_NAME).not.toBe(ANTIGRAVITY_IDE_HOOK_NAMESPACE);

    // Disconnect the IDE — the CLI's bundle must survive.
    uninstallAntigravityIdeHooks(ideTarget);
    cfg = JSON.parse(readFileSync(sharedHooks, 'utf8'));
    expect(cfg[ANTIGRAVITY_IDE_HOOK_NAMESPACE]).toBeUndefined();
    expect(cfg[ANTIGRAVITY_BLOCK_NAME]).toBeDefined();

    // And the reverse: disconnect the CLI — the IDE's bundle must survive.
    installAntigravityIdeHooks(ideTarget);
    uninstallAntigravityCliHooks(cliTarget);
    cfg = JSON.parse(readFileSync(sharedHooks, 'utf8'));
    expect(cfg[ANTIGRAVITY_BLOCK_NAME]).toBeUndefined();
    expect(cfg[ANTIGRAVITY_IDE_HOOK_NAMESPACE]).toBeDefined();
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
      await runAntigravityIdeInstall({ project: true, cwd: dir });
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

describe('antigravity-ide detection keys on the IDE-specific dir, not shared ~/.gemini', () => {
  test('a CLI-only ~/.gemini (root + config + antigravity-cli) does NOT detect the IDE', () => {
    // Simulate what `connect antigravity-cli` leaves behind: it creates ~/.gemini,
    // ~/.gemini/config/hooks.json, and ~/.gemini/antigravity-cli/ — but never
    // ~/.gemini/antigravity-ide/. This used to falsely detect the IDE (bug).
    mkdirSync(join(geminiHomeDir, 'config'), { recursive: true });
    mkdirSync(join(geminiHomeDir, 'antigravity-cli'), { recursive: true });
    expect(antigravityIdeInstalledOnHost()).toBe(false);
  });

  test('the IDE product dir makes it detect', () => {
    mkdirSync(join(geminiHomeDir, 'antigravity-ide'), { recursive: true });
    expect(antigravityIdeInstalledOnHost()).toBe(true);
    // and the plugin surfaces that (host signal short-circuits the OR)
    expect(antigravityIdePlugin.connect!.detect()).toBe(true);
  });
});
