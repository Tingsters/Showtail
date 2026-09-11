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
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../src/core/codex.ts';
import { runCodexInstall, runCodexUninstall } from '../src/commands/codex.ts';
import { blockFor } from '../src/core/managedBlock.ts';
import { codexPlugin } from '../src/plugins/codex.ts';
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
    const lines: string[] = [];
    const realLog = console.log;
    try {
      // Mark dir as a Showtail project so project-scope resolution stops here
      // (otherwise findRoot can walk up to a stray ~/.showtail).
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      console.log = (...args: unknown[]) => void lines.push(args.join(' '));
      await runCodexInstall({ project: true, hooks: false, cwd: dir });
      const target = resolveCodexTarget('project', dir);
      expect(existsSync(target.agentsFile)).toBe(true);
      expect(existsSync(target.hooksFile)).toBe(false);
      expect(existsSync(target.configToml)).toBe(false);
      expect(codexAutoCaptureActive(dir)).toBe(false);

      const output = lines.join('\n');
      expect(output).toContain('routine prompts');
      expect(output).toContain('will not be captured automatically');
      expect(output).toContain('restore hands-free capture');
      expect(output).not.toContain('teaches Codex to log prompts');
    } finally {
      console.log = realLog;
      cleanup(dir);
    }
  });

  test('install --no-hooks removes hooks from an earlier connect', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'), { recursive: true });
      const target = resolveCodexTarget('project', dir);
      await runCodexInstall({ project: true, yes: true, cwd: dir });
      expect(codexHooksInstalledAt(target.hooksFile)).toBe(true);

      await runCodexInstall({ project: true, hooks: false, cwd: dir });

      expect(existsSync(target.agentsFile)).toBe(true);
      expect(codexHooksInstalledAt(target.hooksFile)).toBe(false);
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
  test('uses tool-specific capture status and no routine manual capture commands', () => {
    expect(AGENTS_BODY).toContain('showtail status --json --tool codex');
    expect(AGENTS_BODY).toContain('"mode": "automatic"');
    expect(AGENTS_BODY).not.toContain('"hooksActive"');
    expect(AGENTS_BODY).not.toContain('showtail ensure');
    expect(AGENTS_BODY).not.toContain('showtail log --type');
    expect(AGENTS_BODY).not.toContain('showtail artifact');
    expect(AGENTS_BODY).toContain('showtail projects "<student-project-wording>" --json');
    expect(AGENTS_BODY).toContain(
      'showtail report --project "<trail-id>" --json --no-open',
    );
    expect(AGENTS_BODY).toContain('showtail verify --project "<trail-id>" --json');
    expect(AGENTS_BODY).toContain(
      'showtail status --project "<trail-id>" --json --tool codex',
    );
    expect(AGENTS_BODY).toContain("agent terminal's working directory");
    expect(AGENTS_BODY).toContain('returned `trailId` and `root`');
    expect(AGENTS_BODY).not.toMatch(
      /^\s*showtail (?:report|verify|status)(?:\s+#.*)?\s*$/m,
    );
    expect(AGENTS_BODY).not.toMatch(/`showtail (?:report|verify|status)`/);
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

describe('legacy HOME-level Codex instructions cleanup', () => {
  function userTarget(dir: string) {
    const codexDir = join(dir, '.codex');
    return {
      scope: 'user' as const,
      codexDir,
      hooksFile: join(codexDir, 'hooks.json'),
      configToml: join(codexDir, 'config.toml'),
      agentsFile: join(codexDir, 'AGENTS.md'),
      legacyAgentsFile: join(dir, 'AGENTS.md'),
    };
  }

  test('removes an untouched fingerprinted block and preserves surrounding user text', () => {
    const dir = makeTempDir();
    try {
      const target = userTarget(dir);
      writeFileSync(
        target.legacyAgentsFile,
        `# My rules\n\n${blockFor(AGENTS_BODY)}\n\nKeep this too.\n`,
      );

      writeCodexInstructions(target);

      const legacy = readFileSync(target.legacyAgentsFile, 'utf8');
      expect(legacy).toContain('# My rules');
      expect(legacy).toContain('Keep this too.');
      expect(legacy).not.toContain('showtail:start');
      expect(readFileSync(target.agentsFile, 'utf8')).toContain('showtail:start');
    } finally {
      cleanup(dir);
    }
  });

  test('preserves edited and unrecognized managed blocks byte-for-byte', () => {
    for (const legacyBlock of [
      blockFor(AGENTS_BODY).replace('help the student', 'help my student'),
      blockFor('# Another tool\n\nThis is not the Codex Showtail instruction body.'),
    ]) {
      const dir = makeTempDir();
      const originalWarn = console.warn;
      try {
        const target = userTarget(dir);
        writeFileSync(target.legacyAgentsFile, legacyBlock + '\n');
        console.warn = () => {};

        writeCodexInstructions(target);

        expect(readFileSync(target.legacyAgentsFile, 'utf8')).toBe(legacyBlock + '\n');
      } finally {
        console.warn = originalWarn;
        cleanup(dir);
      }
    }
  });
});
