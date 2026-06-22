import { describe, expect, test } from 'bun:test';
import {
  PLUGINS,
  connectPluginOrThrow,
  connectPlugins,
  getPlugin,
  getPluginById,
  importPlugins,
  labelForTool,
} from '../src/plugins/registry.ts';

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
