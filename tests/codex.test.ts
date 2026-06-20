import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_BODY,
  codexAutoCaptureActive,
  codexHooksFeatureEnabled,
  codexHooksInstalledAt,
  codexInstructionsState,
  enableCodexHooksFeature,
  resolveCodexTarget,
} from '../src/core/codex.ts';
import { runCodexInstall, runCodexUninstall } from '../src/commands/codex.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('codex install / uninstall', () => {
  test('install writes AGENTS.md block + hooks.json and enables features.hooks', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      const target = resolveCodexTarget('project', dir);

      expect(existsSync(target.agentsFile)).toBe(true);
      expect(readFileSync(target.agentsFile, 'utf8')).toContain('showtail:start');
      expect(codexHooksInstalledAt(target.hooksFile)).toBe(true);
      expect(codexAutoCaptureActive(dir)).toBe(true);
      expect(codexHooksFeatureEnabled(target.configToml)).toBe(true);

      await runCodexUninstall({ cwd: dir });
      // Block was the only content, so AGENTS.md is removed; hooks emptied.
      expect(existsSync(target.agentsFile)).toBe(false);
      expect(codexHooksInstalledAt(target.hooksFile)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install is idempotent (no duplicate block or hook entries)', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      const target = resolveCodexTarget('project', dir);

      const agents = readFileSync(target.agentsFile, 'utf8');
      expect(agents.match(/showtail:start/g)?.length).toBe(1);

      const hooks = JSON.parse(readFileSync(target.hooksFile, 'utf8'));
      const post = hooks.hooks.PostToolUse as Array<{ hooks: { command: string }[] }>;
      const ours = post.filter((g) => g.hooks?.[0]?.command?.includes('showtail hook'));
      expect(ours).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('install --no-hooks writes only AGENTS.md, no hooks/config', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCodexInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveCodexTarget('project', dir);
      expect(existsSync(target.agentsFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(existsSync(target.configToml)).toBe(false);
      expect(codexAutoCaptureActive(dir)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('install preserves user content in AGENTS.md outside the block', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveCodexTarget('project', dir);
      writeFileSync(target.agentsFile, '# My project rules\n\nUse tabs.\n');
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      const after = readFileSync(target.agentsFile, 'utf8');
      expect(after).toContain('# My project rules');
      expect(after).toContain('Use tabs.');
      expect(after).toContain('showtail:start');

      // Uninstall strips our block but keeps the user's text.
      await runCodexUninstall({ cwd: dir });
      const cleaned = readFileSync(target.agentsFile, 'utf8');
      expect(cleaned).toContain('# My project rules');
      expect(cleaned).not.toContain('showtail:start');
    } finally {
      cleanup(dir);
    }
  });

  test('a user-edited block is respected; --force takes the latest', async () => {
    const dir = makeTempDir();
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      const target = resolveCodexTarget('project', dir);

      // Simulate a hand-edit inside the managed block.
      const edited = readFileSync(target.agentsFile, 'utf8').replace(
        'Showtail',
        'Showtail (my notes)',
      );
      writeFileSync(target.agentsFile, edited);
      expect(codexInstructionsState(target).userEdited).toBe(true);

      // A normal re-install must NOT clobber the edit.
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      expect(readFileSync(target.agentsFile, 'utf8')).toContain('my notes');

      // --force restores the canonical body.
      await runCodexInstall({ project: true, yes: true, force: true, cwd: dir });
      expect(readFileSync(target.agentsFile, 'utf8')).not.toContain('my notes');
      expect(codexInstructionsState(target).upToDate).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

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

describe('codex AGENTS body', () => {
  test('teaches logging tagged --tool codex', () => {
    expect(AGENTS_BODY).toContain('--tool codex');
    expect(AGENTS_BODY).toContain('showtail status --json');
  });
});
