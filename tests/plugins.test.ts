import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLUGINS,
  connectPluginOrThrow,
  connectPlugins,
  getPlugin,
  getPluginById,
  importPlugins,
  labelForTool,
} from '../src/plugins/registry.ts';
import { resolveTarget } from '../src/core/skill.ts';
import { resolveCopilotTarget } from '../src/core/copilot.ts';
import { resolveCopilotCliTarget } from '../src/core/copilotCli.ts';
import { resolveCodexTarget } from '../src/core/codex.ts';
import { resolveGeminiCliTarget } from '../src/core/geminiCli.ts';
import { resolveAntigravityCliTarget } from '../src/core/antigravityCli.ts';
import { resolveAntigravityIdeTarget } from '../src/core/antigravityIde.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/**
 * The canonical project-scope instructions/skill file each connect plugin writes.
 * Asserting install/uninstall by this file's presence keeps the tests entirely
 * within a temp project dir — no home-directory reads, so they're deterministic
 * on every platform. (User-scope behavior — `autoConnect`, hook activation — is
 * covered by the spawned `setup.test.ts` e2e, which isolates HOME in a child
 * process; an in-process `os.homedir()` override is not portable.)
 */
const CONNECT_PROJECT_FILE: Record<string, (dir: string) => string> = {
  'claude-code': (dir) => resolveTarget('project', dir).skillFile,
  'github-copilot': (dir) => resolveCopilotTarget(dir).pathInstructionsFile,
  'copilot-cli': (dir) => resolveCopilotCliTarget('project', dir).instructionsFile,
  codex: (dir) => resolveCodexTarget('project', dir).agentsFile,
  'gemini-cli': (dir) => resolveGeminiCliTarget('project', dir).contextFile,
  'antigravity-cli': (dir) => resolveAntigravityCliTarget('project', dir).contextFile,
  'antigravity-ide': (dir) => resolveAntigravityIdeTarget('project', dir).contextFile,
};

describe('plugin registry', () => {
  test('every plugin can be looked up by cliName, id, and each alias', () => {
    for (const p of PLUGINS) {
      expect(getPlugin(p.cliName)).toBe(p);
      expect(getPlugin(p.id)).toBe(p);
      expect(getPlugin(p.cliName.toUpperCase())).toBe(p); // case-insensitive
      for (const alias of p.aliases) expect(getPlugin(alias)).toBe(p);
    }
  });

  test('getPluginById resolves by canonical tool id', () => {
    expect(getPluginById('gemini-cli')?.cliName).toBe('gemini-cli');
    expect(getPluginById('claude-code')?.cliName).toBe('claude');
    expect(getPluginById('not-a-tool')).toBeUndefined();
  });

  test('connect/import views partition by capability', () => {
    expect(connectPlugins().every((p) => Boolean(p.connect))).toBe(true);
    expect(importPlugins().every((p) => Boolean(p.import))).toBe(true);
    // Claude Code is the one tool with both capabilities.
    const claude = getPluginById('claude-code')!;
    expect(claude.connect).toBeDefined();
    expect(claude.import).toBeDefined();
  });

  test('connect tools include the expected set plus the new gemini-cli', () => {
    const names = connectPlugins().map((p) => p.cliName);
    expect(names).toEqual(
      expect.arrayContaining(['claude', 'copilot', 'codex', 'gemini-cli']),
    );
  });

  test('connectPluginOrThrow resolves known tools and rejects unknown ones', () => {
    expect(connectPluginOrThrow('claude').id).toBe('claude-code');
    expect(connectPluginOrThrow('gemini-cli').id).toBe('gemini-cli');
    // The Gemini web app is import-only — not connectable.
    expect(() => connectPluginOrThrow('gemini')).toThrow(/Unknown tool/);
    expect(() => connectPluginOrThrow('nope')).toThrow(/Choose one of/);
  });

  test("import 'gemini' is the web app, distinct from the gemini-cli connect tool", () => {
    expect(getPlugin('gemini')?.id).toBe('google-gemini');
    expect(getPlugin('gemini-cli')?.id).toBe('gemini-cli');
  });

  test('labelForTool resolves every plugin id, with a CLI fallback', () => {
    for (const p of PLUGINS) expect(labelForTool(p.id)).toBe(p.label);
    expect(labelForTool('cli')).toBe('CLI');
    expect(labelForTool('mystery-tool')).toBe('mystery-tool');
  });

  test("each connect plugin's applicableFlags are a subset of its declared flags", () => {
    for (const p of connectPlugins()) {
      const declared = new Set(p.connect.flags.map((f) => f.name));
      for (const name of p.connect.applicableFlags) expect(declared.has(name)).toBe(true);
    }
  });
});

// Exercise the connect-capability wrapper bodies (install / uninstall / detect)
// in-process — they're otherwise only reached through the spawned CLI and don't
// show up in coverage. Project-scope only, so nothing touches the real home dir.
describe('plugin connect capabilities', () => {
  test('each connect plugin installs and uninstalls at project scope', async () => {
    for (const p of connectPlugins()) {
      const dir = makeTempDir();
      try {
        // Mark the dir a project so project-scope resolution stops here.
        mkdirSync(join(dir, '.showtail'), { recursive: true });
        const file = CONNECT_PROJECT_FILE[p.id]!(dir);

        expect(existsSync(file)).toBe(false);
        await p.connect.install({
          project: true,
          hooks: false,
          extension: false,
          cwd: dir,
        });
        expect(existsSync(file)).toBe(true);

        await p.connect.uninstall({ cwd: dir });
        expect(existsSync(file)).toBe(false);
      } finally {
        cleanup(dir);
      }
    }
  });

  test('detect() returns a boolean for every connect plugin', () => {
    // The value depends on what's installed on the host; only the contract is
    // asserted (deterministic, no env reads to depend on).
    for (const p of connectPlugins()) {
      expect(typeof p.connect.detect()).toBe('boolean');
    }
  });

  test('autoConnect is declared for every auto-connectable tool (incl. Copilot/VS Code)', () => {
    // Calling autoConnect writes user-scope (home) files / installs an extension, which is
    // covered by setup.test.ts and the extension tests; here we only assert the contract.
    expect(typeof getPluginById('claude-code')!.connect!.autoConnect).toBe('function');
    expect(typeof getPluginById('codex')!.connect!.autoConnect).toBe('function');
    expect(typeof getPluginById('gemini-cli')!.connect!.autoConnect).toBe('function');
    // Copilot/VS Code now auto-connects too — it installs the Showtail VS Code extension
    // (capture rides on the extension), so it is NOT pre-seedable before install.
    expect(typeof getPluginById('github-copilot')!.connect!.autoConnect).toBe('function');
    expect(getPluginById('github-copilot')!.connect!.prewireSafe).toBe(false);
  });
});
