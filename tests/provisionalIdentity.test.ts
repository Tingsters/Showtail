import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAllEventsWithSession } from '../src/core/events.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, enableAutoInit, makeTempDir, runCli, spawnEnv } from './helpers.ts';

/** Env with NO resolvable identity from any source, isolated homes, tracking on. */
function noIdentityEnv(home: string, ghome: string, idhome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...spawnEnv(),
    HOME: home,
    USERPROFILE: home,
    SHOWTAIL_HOME: ghome,
    SHOWTAIL_IDENTITY_HOME: idhome,
    // Point git's global/system config at nothing so only repo-local counts.
    GIT_CONFIG_GLOBAL: join(home, 'no-such-gitconfig'),
    GIT_CONFIG_SYSTEM: join(home, 'no-such-gitconfig'),
  };
  // Remove every real-identity source so the provisional fallback is exercised.
  delete env.SHOWTAIL_IDENTITY_EMAIL;
  delete env.EMAIL;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_EMAIL;
  return env;
}

function userPrompt(cwd: string, prompt: string, sid: string): string {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
    session_id: sid,
  });
}

function promptEventsBySlug(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of readAllEventsWithSession(pathsForRoot(dir))) {
    if (e.event.type === 'prompt') out[e.actorSlug] = (out[e.actorSlug] ?? 0) + 1;
  }
  return out;
}

describe('provisional identity → auto-link (end-to-end, no git then git)', () => {
  test('captures under a placeholder with no identity, then re-attributes to the real one', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    const ghome = join(makeTempDir(), '.showtail-cli');
    const idhome = join(makeTempDir(), 'id');
    try {
      // A real git repo (eligible anchor), but NO git identity configured yet.
      expect(spawnSync('git', ['init'], { cwd: dir }).status).toBe(0);
      writeFileSync(join(dir, 'package.json'), '{}\n');
      enableAutoInit(ghome); // tracking on, and (autoInit defined) skips the first-run bootstrap
      const env = noIdentityEnv(home, ghome, idhome);
      const sid = 's-prov';

      // 1. Work with no identity → captured under a provisional placeholder author.
      expect(
        runCli(dir, ['hook', 'session-start'], { input: userPrompt(dir, '', sid), env })
          .code,
      ).toBe(0);
      expect(
        runCli(dir, ['hook', 'user-prompt'], {
          input: userPrompt(dir, 'hello provisional', sid),
          env,
        }).code,
      ).toBe(0);

      const authorsDir = join(dir, '.showtail', 'authors');
      const provFolders = readdirSync(authorsDir);
      expect(provFolders.length).toBe(1);
      const provSlug = provFolders[0]!;
      expect(promptEventsBySlug(dir)[provSlug]).toBe(1); // the provisional prompt is captured

      // 2. Student sets a real git identity (as they must to commit/collaborate).
      spawnSync('git', ['config', 'user.email', 'real@school.edu'], { cwd: dir });
      spawnSync('git', ['config', 'user.name', 'Real Student'], { cwd: dir });

      // 3. Next hook detects the real identity → upgrades + re-attributes everything.
      expect(
        runCli(dir, ['hook', 'user-prompt'], {
          input: userPrompt(dir, 'hello real', sid),
          env,
        }).code,
      ).toBe(0);

      const after = readdirSync(authorsDir);
      expect(after).toEqual(['real-at-school-edu']); // provisional folder gone, real present
      const counts = promptEventsBySlug(dir);
      expect(counts['real-at-school-edu']).toBe(2); // BOTH prompts now under the real identity
      expect(counts[provSlug]).toBeUndefined(); // nothing stranded under the placeholder
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
