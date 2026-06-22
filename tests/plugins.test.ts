import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
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
import { cleanup, makeTempDir } from './helpers.ts';

/**
 * Run `fn` with HOME/USERPROFILE pointed at a throwaway dir and PATH emptied, so
 * a connect plugin's user-scope writes (autoConnect) and detection land in an
 * isolated sandbox — never the developer's real `~/.claude` etc. — and are
 * deterministic regardless of what's installed. Restores the env afterward.
 */
async function withIsolatedHome(
  fn: (home: string) => void | Promise<void>,
): Promise<void> {
  const home = makeTempDir();
  const saved: Record<string, string | undefined> = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.PATH = '';
  try {
    await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(home);
  }
}

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

// These exercise the connect-capability method bodies in-process (install /
// uninstall / status / detect / autoConnect), which are otherwise only reached
// through the spawned CLI and so don't show up in coverage.
describe('plugin connect capabilities', () => {
  test('install → status connected → uninstall round-trips (project scope)', async () => {
    await withIsolatedHome(async () => {
      for (const p of connectPlugins()) {
        const dir = makeTempDir();
        try {
          // Mark the dir a project so project-scope resolution stops here.
          mkdirSync(join(dir, '.showtail'), { recursive: true });
          expect(p.connect.status(dir).connected).toBe(false);

          await p.connect.install({
            project: true,
            hooks: false,
            extension: false,
            cwd: dir,
          });
          expect(p.connect.status(dir).connected).toBe(true);

          await p.connect.uninstall({ cwd: dir });
          expect(p.connect.status(dir).connected).toBe(false);
        } finally {
          cleanup(dir);
        }
      }
    });
  });

  test('detect() is false in an empty sandbox, true once the tool dir appears', async () => {
    await withIsolatedHome(async (home) => {
      // Empty PATH + empty home → nothing detected.
      for (const p of connectPlugins()) expect(p.connect.detect()).toBe(false);
      // Claude detects its `~/.claude` home dir even with no launcher on PATH.
      mkdirSync(join(home, '.claude'), { recursive: true });
      expect(getPluginById('claude-code')!.connect!.detect()).toBe(true);
      // The others key off different dirs/launchers and stay undetected.
      expect(getPluginById('codex')!.connect!.detect()).toBe(false);
      expect(getPluginById('gemini-cli')!.connect!.detect()).toBe(false);
    });
  });

  test('autoConnect enables hooks at user scope for hook-based tools', async () => {
    await withIsolatedHome(async (home) => {
      const cwd = makeTempDir();
      try {
        for (const p of connectPlugins()) {
          const result = p.connect.autoConnect?.(cwd);
          if (result) {
            expect(result).toEqual({ hooks: true });
            // The user-scope write makes auto-capture active for that tool.
            expect(p.connect.status(home).hooksActive).toBe(true);
          }
        }
        // Copilot captures via its VS Code extension — no user-scope autoConnect.
        expect(getPluginById('github-copilot')!.connect!.autoConnect).toBeUndefined();
      } finally {
        cleanup(cwd);
      }
    });
  });
});
