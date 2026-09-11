import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  markPlaced,
} from '../src/core/ledger.ts';
import { CONFIG_VERSION, pathsForRoot, writeJson } from '../src/core/storage.ts';
import { cleanup, CLI, envWithHome, makeTempDir, runCli } from './helpers.ts';

describe('status snapshot', () => {
  test('is a read-only, successful probe in an untracked folder', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const r = runCli(dir, ['status', '--json'], { env: envWithHome(home) });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({
        initialized: false,
        root: null,
        candidateRoot: resolve(dir),
        evidence: 'cwd',
        autoInit: false,
        setupCompleted: false,
        inbox: 0,
        nextAction: 'run-setup',
      });
      expect(typeof out.hooksActive).toBe('boolean');
      expect(Array.isArray(out.tools)).toBe(true);
      expect(out).not.toHaveProperty('requestedRoot');
      expect(existsSync(resolve(dir, '.showtail'))).toBe(false);
      expect(existsSync(resolve(home, 'config.json'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('an explicit path reports both the requested folder and selected project root', () => {
    const project = makeTempDir();
    const caller = makeTempDir();
    const home = makeTempDir();
    try {
      const child = join(project, 'src');
      mkdirSync(child);
      const paths = pathsForRoot(project);
      mkdirSync(paths.base);
      writeJson(paths.config, {
        version: CONFIG_VERSION,
        createdAt: '2026-09-10T00:00:00.000Z',
        anchor: project,
        anchorKind: 'explicit',
        trailId: 'trl_explicit_status',
        settings: {},
      });

      const result = runCli(caller, ['status', child, '--json'], {
        env: envWithHome(home),
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          requestedRoot: resolve(child),
          root: resolve(project),
          candidateRoot: null,
          initialized: true,
        }),
      );
    } finally {
      cleanup(project);
      cleanup(caller);
      cleanup(home);
    }
  });

  test('an explicit untracked folder stays read-only and reports its requested root', () => {
    const project = makeTempDir();
    const caller = makeTempDir();
    const home = makeTempDir();
    try {
      const result = runCli(caller, ['status', project, '--json'], {
        env: envWithHome(home),
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          requestedRoot: resolve(project),
          root: null,
          candidateRoot: resolve(project),
          initialized: false,
        }),
      );
      expect(existsSync(join(project, '.showtail'))).toBe(false);
    } finally {
      cleanup(project);
      cleanup(caller);
      cleanup(home);
    }
  });

  test('a missing explicit folder fails without falling back to the caller', () => {
    const caller = makeTempDir();
    const home = makeTempDir();
    try {
      const missing = join(caller, 'does-not-exist');
      const result = runCli(caller, ['status', missing, '--json'], {
        env: envWithHome(home),
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout);
      expect(payload).toEqual(
        expect.objectContaining({
          ok: false,
          errorCode: 'PATH_NOT_FOUND',
          nextAction: 'choose-existing-path',
          requestedRoot: resolve(missing),
          root: null,
          candidateRoot: null,
          candidates: [],
        }),
      );
      expect(payload.details).toEqual({
        requestedRoot: resolve(missing),
        root: null,
        candidateRoot: null,
        candidates: [],
      });
    } finally {
      cleanup(caller);
      cleanup(home);
    }
  });

  test('human status explains automatic creation without initializing the folder', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const env = envWithHome(home);
      const r = runCli(dir, ['status'], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No Showtail trail exists here yet');
      expect(r.stdout).toContain(resolve(dir));
      expect(existsSync(resolve(dir, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('--tool returns the stable capture contract', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const result = runCli(dir, ['status', '--json', '--tool', 'not-a-tool'], {
        env: envWithHome(home),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).capture).toEqual({
        tool: 'not-a-tool',
        mode: 'disconnected',
        connected: false,
        hooksActive: false,
      });
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('--tool exposes the durable machine-wide capture stop', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ version: 1, captureDisabledTools: ['copilot'] }) + '\n',
        'utf8',
      );
      const result = runCli(dir, ['status', '--json', '--tool', 'copilot'], {
        env: envWithHome(home),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        captureGloballyDisabled: true,
        capture: {
          tool: 'copilot',
          mode: 'disconnected',
          connected: false,
          hooksActive: false,
        },
      });
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('reports matching pending work and recommends report without creating a trail', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const previousHome = process.env.SHOWTAIL_HOME;
    try {
      process.env.SHOWTAIL_HOME = home;
      const ledger = ensureLedgerSession({
        tool: 'codex',
        nativeSessionId: 'status-pending',
        cwd: dir,
      });
      appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'codex',
        text: 'build this project',
      });

      const result = runCli(dir, ['status', '--json', '--verbose-json'], {
        env: envWithHome(home),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          initialized: false,
          candidateRoot: resolve(dir),
          nextAction: 'report',
          matchingPendingSessions: [
            expect.objectContaining({ id: ledger.id, prompts: 1, edits: 0 }),
          ],
        }),
      );
      expect(existsSync(join(dir, '.showtail'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
      cleanup(dir);
      cleanup(home);
    }
  });

  test('stays successful when an existing trail config is unreadable', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'));
      writeFileSync(join(dir, '.showtail', 'config.json'), '{broken');

      const result = runCli(dir, ['status', '--json'], { env: envWithHome(home) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          initialized: true,
          root: resolve(dir),
          trailError: expect.any(String),
        }),
      );
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('human status gives safe recovery guidance for an unreadable config', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      mkdirSync(join(dir, '.showtail'));
      writeFileSync(join(dir, '.showtail', 'config.json'), '{broken');

      const result = runCli(dir, ['status'], { env: envWithHome(home) });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Restore or inspect `.showtail/config.json`');
      expect(result.stdout).not.toContain('showtail track');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  for (const command of ['status', 'capabilities', 'projects']) {
    test(`${command} does not repair a reused path with a different trail id`, () => {
      const dir = makeTempDir();
      const home = makeTempDir();
      const previousHome = process.env.SHOWTAIL_HOME;
      try {
        process.env.SHOWTAIL_HOME = home;
        const ledger = ensureLedgerSession({
          tool: 'codex',
          nativeSessionId: `${command}-read-only`,
          cwd: dir,
        });
        markPlaced(ledger.id, 'trl_stale_at_reused_path', dir);

        const paths = pathsForRoot(dir);
        mkdirSync(paths.base, { recursive: true });
        writeJson(paths.config, {
          version: CONFIG_VERSION,
          createdAt: '2026-09-09T00:00:00.000Z',
          anchor: dir,
          anchorKind: 'cwd',
          trailId: 'trl_live_at_reused_path',
          settings: {},
        });

        const sessionFile = join(home, 'ledger', 'sessions', ledger.id, 'session.json');
        const indexFile = join(home, 'ledger', 'index.json');
        const sessionBefore = readFileSync(sessionFile, 'utf8');
        const indexBefore = readFileSync(indexFile, 'utf8');

        const result = runCli(dir, [command, '--json'], { env: envWithHome(home) });

        expect(result.code).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(readFileSync(sessionFile, 'utf8')).toBe(sessionBefore);
        expect(readFileSync(indexFile, 'utf8')).toBe(indexBefore);
      } finally {
        if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
        else process.env.SHOWTAIL_HOME = previousHome;
        cleanup(dir);
        cleanup(home);
      }
    });

    test(`${command} preserves a pending updater result notice`, () => {
      const dir = makeTempDir();
      const home = makeTempDir();
      try {
        const updateResult = join(home, 'update-result.json');
        const notice = '{"ok":true,"version":"0.16.2","message":"Update completed."}\n';
        const preload = join(home, 'force-stderr-tty.mjs');
        writeFileSync(updateResult, notice);
        writeFileSync(
          preload,
          "Object.defineProperty(process.stderr, 'isTTY', { value: true });\n",
        );

        const result = spawnSync(
          process.execPath,
          [`--preload=${preload}`, 'run', CLI, command],
          {
            cwd: dir,
            encoding: 'utf8',
            env: envWithHome(home),
          },
        );

        expect(result.status).toBe(0);
        expect(readFileSync(updateResult, 'utf8')).toBe(notice);
      } finally {
        cleanup(dir);
        cleanup(home);
      }
    });
  }

  test('verify preserves a pending updater result notice', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const updateResult = join(home, 'update-result.json');
      const notice = '{"ok":true,"version":"0.16.2","message":"Update completed."}\n';
      const preload = join(home, 'force-stderr-tty.mjs');
      writeFileSync(updateResult, notice);
      writeFileSync(
        preload,
        "Object.defineProperty(process.stderr, 'isTTY', { value: true });\n",
      );

      const result = spawnSync(
        process.execPath,
        [`--preload=${preload}`, 'run', CLI, 'verify', '--project', 'trl_missing'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: envWithHome(home),
        },
      );

      expect(result.status).toBe(2);
      expect(readFileSync(updateResult, 'utf8')).toBe(notice);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
