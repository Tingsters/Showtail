import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { runGuardCheck } from '../src/commands/guard.ts';
import { ensureInitialized, ensureTrailIgnore, runInit } from '../src/commands/init.ts';
import {
  GUARD_BEGIN,
  installGuardHooks,
  pushedPaths,
  stagedPaths,
  trailViolations,
  uninstallGuardHooks,
  withGuardBlock,
  withoutGuardBlock,
} from '../src/core/guard.ts';
import { pathsForRoot, readConfig, writeConfig } from '../src/core/storage.ts';
import { CLI, cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeGitProject(): string {
  const dir = makeTempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'user.name', 'Test Student');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

describe('the working trail is private by default', () => {
  test('a new trail ignores itself, so `git add -A` stages nothing from it', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      writeFileSync(join(dir, 'main.py'), 'print(1)');
      // A secret-bearing file in the trail must not be stageable by accident.
      writeFileSync(join(pathsForRoot(dir).objectsDir, 'canary'), 'sk-notarealkey');
      git(dir, 'add', '-A');
      const staged = git(dir, 'diff', '--cached', '--name-only').split('\n');
      expect(staged).toContain('main.py');
      expect(
        staged.filter((p) => p.startsWith('.showtail/') && p !== '.showtail/.gitignore'),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('a legacy committable trail is repaired to private on the next ensure', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      writeFileSync(join(paths.base, '.gitignore'), 'state.json\nreports/\ndiag/\n');
      await ensureInitialized(dir);
      expect(readFileSync(join(paths.base, '.gitignore'), 'utf8')).toContain('\n*\n');
    } finally {
      cleanup(dir);
    }
  });

  test('settings.commitTrail opts a trail into git, and back out again', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const config = readConfig(paths);
      config.settings.commitTrail = true;
      writeConfig(paths, config);
      ensureTrailIgnore(paths);
      const committed = readFileSync(join(paths.base, '.gitignore'), 'utf8');
      expect(committed).toContain('state.json');
      expect(committed).not.toContain('showtail:private');

      config.settings.commitTrail = false;
      writeConfig(paths, config);
      ensureTrailIgnore(paths);
      expect(readFileSync(join(paths.base, '.gitignore'), 'utf8')).toContain(
        'showtail:private',
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('trailViolations', () => {
  test('flags the trail but allows its ignore file', () => {
    expect(
      trailViolations([
        '.showtail/.gitignore',
        '.showtail/config.json',
        '.showtail/objects/ab/cdef',
        'sub/.showtail/authors/x/journal/m/0001.log',
        'src/main.py',
        'docs/showtail.md',
      ]),
    ).toEqual([
      '.showtail/config.json',
      '.showtail/objects/ab/cdef',
      'sub/.showtail/authors/x/journal/m/0001.log',
    ]);
  });

  test('normalises Windows separators', () => {
    expect(trailViolations(['.showtail\\config.json'])).toEqual([
      '.showtail/config.json',
    ]);
  });
});

describe('hook text', () => {
  test('creates, refreshes, preserves user hooks, and removes cleanly', () => {
    const fresh = withGuardBlock(undefined, 'pre-commit');
    expect(fresh.startsWith('#!/bin/sh')).toBe(true);
    expect(fresh).toContain('showtail guard check --staged');

    const mine = '#!/bin/sh\necho "my own hook"\n';
    const added = withGuardBlock(mine, 'pre-commit');
    expect(added).toContain('echo "my own hook"');
    expect(added).toContain(GUARD_BEGIN);
    // Idempotent: applying twice changes nothing.
    expect(withGuardBlock(added, 'pre-commit')).toBe(added);

    const removed = withoutGuardBlock(added)!;
    expect(removed).toContain('echo "my own hook"');
    expect(removed).not.toContain(GUARD_BEGIN);
    expect(withoutGuardBlock(mine)).toBeNull();
  });
});

describe('the git guard', () => {
  test('install writes both hooks, keeps an existing hook, and uninstall removes them', async () => {
    const dir = makeGitProject();
    try {
      const hooks = join(dir, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint"\n');
      expect((await installGuardHooks(dir)).sort()).toEqual(['pre-commit', 'pre-push']);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain('echo "lint"');
      expect(readFileSync(join(hooks, 'pre-push'), 'utf8')).toContain(
        'guard check --push',
      );
      expect(await installGuardHooks(dir)).toEqual([]); // already current

      expect((await uninstallGuardHooks(dir)).sort()).toEqual(['pre-commit', 'pre-push']);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain('echo "lint"');
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).not.toContain(GUARD_BEGIN);
    } finally {
      cleanup(dir);
    }
  });

  test('init installs the guard into a git repo', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
      expect(readFileSync(join(dir, '.git', 'hooks', 'pre-push'), 'utf8')).toContain(
        GUARD_BEGIN,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('a force-added trail file is refused at commit; ordinary files are not', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      writeFileSync(join(dir, 'main.py'), 'print(1)');
      git(dir, 'add', 'main.py');
      await runGuardCheck({ staged: true, cwd: dir }); // fine

      git(dir, 'add', '-f', '.showtail/config.json');
      expect(await stagedPaths(dir)).toContain('.showtail/config.json');
      await expect(runGuardCheck({ staged: true, cwd: dir })).rejects.toThrow(
        /refusing to commit the working trail/,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('a push carrying an already-committed trail is refused', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      writeFileSync(join(dir, 'main.py'), 'print(1)');
      git(dir, 'add', '-A');
      git(dir, 'add', '-f', '.showtail/config.json');
      git(dir, 'commit', '-q', '--no-verify', '-m', 'oops');
      const sha = git(dir, 'rev-parse', 'HEAD');
      const line = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}`;
      expect(await pushedPaths(dir, [line])).toContain('.showtail/config.json');
      // A branch deletion carries nothing.
      expect(
        await pushedPaths(dir, [`(delete) ${'0'.repeat(40)} refs/heads/x ${sha}`]),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('an opted-in (commitTrail) trail is not blocked', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const config = readConfig(paths);
      config.settings.commitTrail = true;
      writeConfig(paths, config);
      ensureTrailIgnore(paths);
      git(dir, 'add', '-f', '.showtail/config.json');
      await runGuardCheck({ staged: true, cwd: dir }); // no throw
    } finally {
      cleanup(dir);
    }
  });
});

describe('the installed hooks, run by real git', () => {
  test('git refuses a commit that carries the working trail, and allows normal commits', () => {
    const dir = makeGitProject();
    const shimDir = makeTempDir();
    try {
      // `showtail` on PATH, as the hook expects, running this checkout's CLI.
      const posix = (p: string) => p.split(String.fromCharCode(92)).join('/');
      const bun = posix(process.execPath);
      const cli = posix(CLI);
      writeFileSync(
        join(shimDir, 'showtail'),
        `#!/bin/sh\nexec "${bun}" run "${cli}" "$@"\n`,
      );
      chmodSync(join(shimDir, 'showtail'), 0o755);
      const env = {
        ...spawnEnv(),
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      };

      expect(runCli(dir, ['ensure'], { env }).code).toBe(0);
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);

      writeFileSync(join(dir, 'main.py'), 'print(1)');
      git(dir, 'add', '-A');
      const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
      const ok = spawnSync('git', ['commit', '-q', '-m', 'work'], {
        cwd: dir,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(ok.status).toBe(0);

      git(dir, 'add', '-f', '.showtail/config.json');
      const bad = spawnSync('git', ['commit', '-q', '-m', 'oops'], {
        cwd: dir,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('refusing to commit the working trail');
      expect(git(dir, 'log', '--oneline').split('\n').length).toBe(1);
    } finally {
      cleanup(dir);
      cleanup(shimDir);
    }
  });
});

describe('the hooks never block because of Showtail itself', () => {
  test('an older showtail with no `guard` command does not stop a commit', () => {
    const dir = makeGitProject();
    const shimDir = makeTempDir();
    try {
      // What a pre-guard showtail does: "unknown command", exit 1.
      writeFileSync(
        join(shimDir, 'showtail'),
        '#!/bin/sh\necho "error: unknown command guard" >&2\nexit 1\n',
      );
      chmodSync(join(shimDir, 'showtail'), 0o755);
      writeFileSync(join(dir, 'main.py'), 'print(1)');
      const hooks = join(dir, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-commit'), withGuardBlock(undefined, 'pre-commit'));
      chmodSync(join(hooks, 'pre-commit'), 0o755);
      git(dir, 'add', '-A');
      const env = {
        ...process.env,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      };
      const r = spawnSync('git', ['commit', '-q', '-m', 'work'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
    } finally {
      cleanup(dir);
      cleanup(shimDir);
    }
  });
});

describe('committing a submission', () => {
  test('a verified submission may be committed; an edited one is refused', async () => {
    const dir = makeGitProject();
    try {
      await runInit({ cwd: dir });
      const { logEvent } = await import('../src/core/events.ts');
      const { authorFor } = await import('./helpers.ts');
      const { runSubmit } = await import('../src/commands/submit.ts');
      await logEvent(authorFor(pathsForRoot(dir)), {
        type: 'prompt',
        text: 'build a parser',
      });
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(' '));
      try {
        await runSubmit({ cwd: dir, sync: false });
      } finally {
        console.log = orig;
      }
      git(dir, 'add', 'showtail-submission');
      await runGuardCheck({ staged: true, cwd: dir }); // verified: fine

      const md = join(dir, 'showtail-submission', 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nedited by hand\n');
      git(dir, 'add', 'showtail-submission');
      await expect(runGuardCheck({ staged: true, cwd: dir })).rejects.toThrow(
        /refusing to commit showtail-submission\/.*changed after signing/,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('reading an untrusted repository', () => {
  test('a repo whose config names a core.fsmonitor program does not run it', async () => {
    const dir = makeGitProject();
    try {
      const marker = join(dir, 'PWNED');
      // The classic attack: git status runs whatever core.fsmonitor points at.
      const hook = join(dir, 'evil.sh');
      writeFileSync(
        hook,
        `#!/bin/sh\necho ran > "${marker.split(String.fromCharCode(92)).join('/')}"\nexit 0\n`,
      );
      chmodSync(hook, 0o755);
      git(dir, 'config', 'core.fsmonitor', hook.split(String.fromCharCode(92)).join('/'));
      // Sanity: plain `git status` really does run it here. (If this git ignores the
      // setting, there is nothing to defend against and the test has nothing to prove.)
      spawnSync('git', ['status'], { cwd: dir });
      if (!existsSync(marker)) return;
      rmSync(marker);
      const { changedFiles, isGitRepo } = await import('../src/core/git.ts');
      expect(await isGitRepo(dir)).toBe(true);
      await changedFiles(dir);
      expect(existsSync(marker)).toBe(false);
      // The guard's own git calls are hardened the same way.
      await stagedPaths(dir);
      expect(existsSync(marker)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
