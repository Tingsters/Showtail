import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import {
  authorSlugs,
  readAuthor,
  resolveActiveAuthorForHook,
} from '../src/core/authors.ts';
import { readMachineIdentity, slugifyEmail } from '../src/core/identity.ts';
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

  test('falls back to a provisional (computer-derived) author when no identity resolves, then auto-upgrades', async () => {
    const dir = makeTempDir();
    const home = makeTempDir(); // a fresh machine cache location (empty)
    const saved = {
      SHOWTAIL_IDENTITY_EMAIL: process.env.SHOWTAIL_IDENTITY_EMAIL,
      SHOWTAIL_IDENTITY_HOME: process.env.SHOWTAIL_IDENTITY_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      EMAIL: process.env.EMAIL,
    };
    // No real identity from any source: no env override, no git config, no author env.
    delete process.env.SHOWTAIL_IDENTITY_EMAIL;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.EMAIL;
    process.env.SHOWTAIL_IDENTITY_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'no-such-gitconfig');
    try {
      const paths = pathsForRoot(dir);
      mkdirSync(paths.authorsDir, { recursive: true });
      mkdirSync(paths.objectsDir, { recursive: true });
      writeJson(paths.config, {
        version: CONFIG_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        settings: { git: false },
      });
      writeState(paths, { currentSessionId: null });

      // No identity → a provisional author is created (work is never dropped), marked
      // provisional in both author.json and the machine cache.
      const prov = await resolveActiveAuthorForHook(paths, { cwd: dir });
      expect(prov).toBeDefined();
      const provSlug = readState(paths).currentAuthorSlug!;
      expect(provSlug).toBeTruthy();
      expect(readAuthor(prov!)?.provisional).toBe(true);
      expect(readMachineIdentity()?.provisional).toBe(true);

      // A real identity now appears (e.g. the student set git, exposed here via env) →
      // the next resolve upgrades: real author active, provisional folder removed, cache real.
      process.env.GIT_AUTHOR_EMAIL = 'real@school.edu';
      const real = await resolveActiveAuthorForHook(paths, { cwd: dir });
      const realSlug = slugifyEmail('real@school.edu');
      expect(readState(paths).currentAuthorSlug).toBe(realSlug);
      expect(real?.slug).toBe(realSlug);
      expect(readMachineIdentity()?.provisional).toBeUndefined();
      expect(authorSlugs(paths)).toContain(realSlug);
      expect(existsSync(prov!.dir)).toBe(false); // placeholder folder gone
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      cleanup(home);
      cleanup(dir);
    }
  });
});
