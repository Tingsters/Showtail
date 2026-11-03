import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  codexHooksFeatureEnabled,
  enableCodexHooksFeature,
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../src/core/codex.ts';
import { codexPlugin } from '../src/plugins/codex.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('enableCodexHooksFeature (config.toml)', () => {
  test('creates the file with a [features] table when absent', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'config.toml');
      expect(enableCodexHooksFeature(path)).toBe('created');
      expect(codexHooksFeatureEnabled(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('inserts into an existing [features] table without clobbering keys', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'config.toml');
      writeFileSync(path, 'model = "gpt-5"\n\n[features]\nweb_search = true\n');
      expect(enableCodexHooksFeature(path)).toBe('updated');
      const out = readFileSync(path, 'utf8');
      expect(out).toContain('model = "gpt-5"');
      expect(out).toContain('web_search = true');
      expect(codexHooksFeatureEnabled(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('flips an existing hooks = false and is idempotent on true', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'config.toml');
      writeFileSync(path, '[features]\nhooks = false\n');
      expect(enableCodexHooksFeature(path)).toBe('updated');
      expect(codexHooksFeatureEnabled(path)).toBe(true);
      expect(enableCodexHooksFeature(path)).toBe('unchanged');
    } finally {
      cleanup(dir);
    }
  });

  test('handles a dotted features.hooks key', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'config.toml');
      writeFileSync(path, 'features.hooks = false\n');
      expect(enableCodexHooksFeature(path)).toBe('updated');
      expect(readFileSync(path, 'utf8')).toContain('features.hooks = true');
      expect(codexHooksFeatureEnabled(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('appends a [features] table when none exists', () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'config.toml');
      writeFileSync(path, 'model = "gpt-5"\n');
      expect(enableCodexHooksFeature(path)).toBe('updated');
      const out = readFileSync(path, 'utf8');
      expect(out).toContain('model = "gpt-5"');
      expect(out).toContain('[features]');
      expect(codexHooksFeatureEnabled(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('codex user-scope status', () => {
  test('reports connected when only user-scope instructions are installed', () => {
    const dir = makeTempDir();
    const project = makeTempDir();
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(dir, '.codex');
      mkdirSync(join(project, '.showtail'), { recursive: true });
      writeCodexInstructions(resolveCodexTarget('user', project));

      expect(codexPlugin.connect!.status(project)).toEqual({
        connected: true,
        hooksActive: false,
        updateAvailable: false,
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      cleanup(dir);
      cleanup(project);
    }
  });

  test('reports connected when only user-scope hooks are installed', () => {
    const dir = makeTempDir();
    const project = makeTempDir();
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(dir, '.codex');
      mkdirSync(join(project, '.showtail'), { recursive: true });
      installCodexHooks(resolveCodexTarget('user', project));

      expect(codexPlugin.connect!.status(project)).toEqual({
        connected: true,
        hooksActive: true,
        updateAvailable: undefined,
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      cleanup(dir);
      cleanup(project);
    }
  });
});
