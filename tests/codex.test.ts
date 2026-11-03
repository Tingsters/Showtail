import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  codexHookHealth,
  codexHooksFeatureEnabled,
  enableCodexHooksFeature,
  installCodexHooks,
  resolveCodexTarget,
  writeCodexInstructions,
} from '../src/core/codex.ts';
import { codexPlugin, inspectCodexCapture } from '../src/plugins/codex.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('Codex post-tool observer dispatch', () => {
  const observed = (name: string) =>
    CODEX_HOOK_EVENTS.PostToolUse!.some(
      (group) => !group.matcher || new RegExp(group.matcher).test(name),
    );

  test('observes current normalized shell hooks and older shell names', () => {
    // Codex 0.166 emits Bash for both shell commands and unified exec. Older
    // recorded hosts emitted shell_command. Missing Bash silently loses the
    // post-edit observation until a later lifecycle callback catches up.
    for (const name of ['Bash', 'shell_command', 'apply_patch']) {
      expect(observed(name)).toBe(true);
    }
  });

  test('does not observe unrelated tools or partial tool-name matches', () => {
    for (const name of ['Read', 'update_plan', 'not_apply_patch', 'BashExtra']) {
      expect(observed(name)).toBe(false);
    }
  });
});

describe('Codex host hook verification', () => {
  const listing = (trustStatus: string, extra: Record<string, unknown> = {}) => ({
    data: [
      {
        hooks: [
          ['sessionStart', 'session-start'],
          ['postToolUse', 'post-edit'],
          ['stop', 'stop'],
        ].map(([eventName, event]) => ({
          handlerType: 'command',
          command: `showtail hook ${event} --tool codex`,
          eventName,
          enabled: true,
          trustStatus,
          ...extra,
        })),
        errors: [],
      },
    ],
  });

  test('new and modified callback definitions require host review', () => {
    for (const state of ['untrusted', 'modified']) {
      const health = codexHookHealth(listing(state));
      expect(health.hooksActive).toBe(false);
      expect(health.issues[0]?.code).toBe('HOOK_TRUST_REQUIRED');
      expect(health.issues[0]?.message).toContain('/hooks');
    }
  });

  test('only complete enabled callbacks with host trust are active', () => {
    for (const state of ['trusted', 'managed']) {
      const result = listing(state);
      result.data[0]!.hooks.push({
        handlerType: 'command',
        command: 'unrelated-hook',
        eventName: 'stop',
        enabled: false,
        trustStatus: 'untrusted',
      });
      expect(codexHookHealth(result)).toEqual({ hooksActive: true, issues: [] });
    }
    expect(codexHookHealth(listing('trusted', { enabled: false })).issues[0]?.code).toBe(
      'HOOKS_DISABLED',
    );
    const missing = listing('trusted');
    missing.data[0]!.hooks.pop();
    expect(codexHookHealth(missing).issues[0]?.code).toBe('HOOKS_NOT_LOADED');
  });

  test('malformed and rejected host configuration never claims active capture', () => {
    for (const result of [null, {}, { data: [] }, { data: [null] }]) {
      expect(codexHookHealth(result)).toMatchObject({ hooksActive: false });
      expect(codexHookHealth(result).issues[0]?.code).toBe('HOOK_STATE_UNAVAILABLE');
    }
    const invalid = listing('trusted') as {
      data: { hooks: unknown[]; errors: unknown[] }[];
    };
    invalid.data[0]!.errors.push({ message: 'invalid hook', path: '/private/path' });
    expect(codexHookHealth(invalid).issues[0]?.code).toBe('HOOK_CONFIG_INVALID');
    expect(JSON.stringify(codexHookHealth(invalid))).not.toContain('/private/path');
  });

  test('host verification only lists callbacks and closes its read-only transport', async () => {
    const calls: { method: string; params: unknown }[] = [];
    let closed = false;
    const result = await inspectCodexCapture('/project', async () => ({
      async request(method, params) {
        calls.push({ method, params });
        return listing('trusted');
      },
      close() {
        closed = true;
      },
    }));
    expect(result).toEqual({ hooksActive: true, issues: [] });
    expect(calls).toEqual([{ method: 'hooks/list', params: { cwds: ['/project'] } }]);
    expect(closed).toBe(true);
  });

  test('unsupported host inspection never starts a conversation as a fallback', async () => {
    const calls: string[] = [];
    let closed = false;
    const result = await inspectCodexCapture('/project', async () => ({
      async request(method) {
        calls.push(method);
        throw new Error('method not found');
      },
      close() {
        closed = true;
      },
    }));
    expect(result.hooksActive).toBe(false);
    expect(result.issues[0]?.code).toBe('HOOK_STATE_UNAVAILABLE');
    expect(calls).toEqual(['hooks/list']);
    expect(closed).toBe(true);
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
