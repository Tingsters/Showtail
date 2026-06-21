import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { authorSlugs, resolveActiveAuthorForHook } from '../src/core/authors.ts';
import {
  CONFIG_VERSION,
  pathsForRoot,
  readState,
  writeJson,
  writeState,
} from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('hook author resolution (cheap, never prompts)', () => {
  test('records the active author from the machine identity when state has none', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      // Simulate a machine that has the project but no recorded active author yet
      // (e.g. a teammate who cloned the repo). The hook must resolve it silently.
      writeState(paths, { currentSessionId: null });

      const author = await resolveActiveAuthorForHook(paths, { cwd: dir });
      expect(author?.slug).toBe('tester-at-example-com');
      // It records the resolved slug and ensures the author folder exists.
      expect(readState(paths).currentAuthorSlug).toBe('tester-at-example-com');
      expect(authorSlugs(paths)).toContain('tester-at-example-com');
    } finally {
      cleanup(dir);
    }
  });

  test('no-ops (no folder, no prompt) when identity cannot be settled silently', async () => {
    const dir = makeTempDir();
    const home = makeTempDir(); // a fresh machine cache location (empty)
    const prevEmail = process.env.SHOWTAIL_IDENTITY_EMAIL;
    const prevHome = process.env.SHOWTAIL_IDENTITY_HOME;
    const prevG = process.env.GIT_CONFIG_GLOBAL;
    const prevS = process.env.GIT_CONFIG_SYSTEM;
    delete process.env.SHOWTAIL_IDENTITY_EMAIL;
    process.env.SHOWTAIL_IDENTITY_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'no-such-gitconfig');
    try {
      // Build a project shell WITHOUT runInit (which would establish identity via
      // gh/git/prompt) so identity is genuinely unresolvable here.
      const paths = pathsForRoot(dir);
      mkdirSync(paths.authorsDir, { recursive: true });
      mkdirSync(paths.objectsDir, { recursive: true });
      writeJson(paths.config, {
        version: CONFIG_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        settings: { git: false },
      });
      writeState(paths, { currentSessionId: null });

      const author = await resolveActiveAuthorForHook(paths, { cwd: dir });
      expect(author).toBeUndefined();
      expect(readState(paths).currentAuthorSlug).toBeUndefined();
    } finally {
      process.env.SHOWTAIL_IDENTITY_EMAIL = prevEmail;
      if (prevHome === undefined) delete process.env.SHOWTAIL_IDENTITY_HOME;
      else process.env.SHOWTAIL_IDENTITY_HOME = prevHome;
      if (prevG === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevG;
      if (prevS === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prevS;
      cleanup(home);
      cleanup(dir);
    }
  });
});
