import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, enableAutoInit, envWithHome, makeTempDir, runCli } from './helpers.ts';

function fakeHomeEnv(home: string, globalHome: string): NodeJS.ProcessEnv {
  return {
    ...envWithHome(globalHome),
    HOME: home,
    USERPROFILE: home,
    SHOWTAIL_ROOT_CEILING: home,
  };
}

function prompt(cwd: string, sessionId: string, text: string): string {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    session_id: sessionId,
    prompt: text,
  });
}

function edit(cwd: string, sessionId: string, file: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    cwd,
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: {
      file_path: file,
      old_string: 'before',
      new_string: 'after',
    },
  });
}

function promptTexts(root: string): string[] {
  return readAllEvents(pathsForRoot(root))
    .filter((event) => event.type === 'prompt')
    .map((event) => event.text);
}

describe('project-aware routing', () => {
  test('explicit track and ensure work at HOME without leaking into descendants', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      const env = fakeHomeEnv(home, globalHome);
      const tracked = runCli(home, ['track', '--json'], { env });
      const ensured = runCli(home, ['ensure', '--json'], { env });

      expect(tracked.code).toBe(0);
      expect(ensured.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual(
        expect.objectContaining({
          created: true,
          root: home,
          anchorKind: 'explicit',
          backfilled: 0,
        }),
      );
      expect(JSON.parse(ensured.stdout)).toEqual(
        expect.objectContaining({
          created: false,
          initialized: true,
          root: home,
          anchorKind: 'explicit',
        }),
      );
      expect(existsSync(join(home, '.showtail', 'config.json'))).toBe(true);
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('an accidental HOME trail never captures a nested git project', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      // Create the legacy/catch-all trail before treating this directory as HOME.
      expect(
        runCli(home, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      enableAutoInit(globalHome);
      const repo = join(home, 'school', 'parser');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const env = fakeHomeEnv(home, globalHome);

      expect(
        runCli(repo, ['hook', 'user-prompt'], {
          env,
          input: prompt(repo, 'nested-repo', 'build the parser'),
        }).code,
      ).toBe(0);

      expect(existsSync(join(repo, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(repo)).toContain('build the parser');
      expect(promptTexts(home)).not.toContain('build the parser');
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('a HOME trail does not claim a direct HOME edit from a child launch', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      expect(
        runCli(home, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      enableAutoInit(globalHome);
      const launcher = join(home, 'tool-state');
      mkdirSync(launcher, { recursive: true });
      const homeFile = join(home, 'notes.ts');
      writeFileSync(homeFile, 'export const note = true;\n');
      const env = fakeHomeEnv(home, globalHome);
      const sessionId = 'child-launch-home-edit';

      expect(
        runCli(launcher, ['hook', 'user-prompt'], {
          env,
          input: prompt(launcher, sessionId, 'update my note'),
        }).code,
      ).toBe(0);
      expect(existsSync(join(launcher, '.showtail', 'config.json'))).toBe(true);

      expect(
        runCli(launcher, ['hook', 'post-edit'], {
          env,
          input: edit(launcher, sessionId, homeFile),
        }).code,
      ).toBe(0);

      expect(promptTexts(home)).not.toContain('update my note');
      // The automatic shell remains for concurrency safety, but the mixed-root
      // session is no longer projected into it.
      expect(existsSync(join(launcher, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(launcher)).toEqual([]);
      expect(readAllArtifacts(pathsForRoot(launcher))).toEqual([]);
      const inbox = JSON.parse(
        runCli(launcher, ['inbox', '--all', '--json'], { env }).stdout,
      ).sessions;
      expect(inbox).toContainEqual(
        expect.objectContaining({
          nativeSessionId: sessionId,
          status: 'inbox',
          prompts: 1,
          edits: 1,
        }),
      );
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('a HOME git checkout does not hide a nested marker-based project', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      expect(
        runCli(home, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      mkdirSync(join(home, '.git'), { recursive: true });
      enableAutoInit(globalHome);
      const project = join(home, 'school', 'web-app');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'package.json'), '{}\n');
      const env = fakeHomeEnv(home, globalHome);

      expect(
        runCli(project, ['hook', 'user-prompt'], {
          env,
          input: prompt(project, 'nested-marker', 'build the web app'),
        }).code,
      ).toBe(0);

      expect(existsSync(join(project, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(project)).toContain('build the web app');
      expect(promptTexts(home)).not.toContain('build the web app');
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('status stays read-only and report refuses empty work across a project boundary', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      expect(
        runCli(home, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      const repo = join(home, 'school', 'untracked-repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const env = fakeHomeEnv(home, globalHome);

      const status = runCli(repo, ['status', '--json'], { env });
      const report = runCli(repo, ['report', '--format', 'json', '--no-open'], { env });

      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual(
        expect.objectContaining({
          initialized: false,
          root: null,
          candidateRoot: repo,
          evidence: 'git',
        }),
      );
      expect(report.code).toBe(4);
      expect(report.stderr).toContain('No captured Showtail work resolves');
      expect(existsSync(join(repo, '.showtail'))).toBe(false);
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('a session launched from HOME follows its first project edit', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      enableAutoInit(globalHome);
      const repo = join(home, 'school', 'calculator');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const file = join(repo, 'calculator.ts');
      writeFileSync(file, 'export const answer = 42;\n');
      const env = fakeHomeEnv(home, globalHome);
      const sessionId = 'home-to-project';

      expect(
        runCli(home, ['hook', 'user-prompt'], {
          env,
          input: prompt(home, sessionId, 'make a calculator'),
        }).code,
      ).toBe(0);
      expect(promptTexts(home)).toContain('make a calculator');

      expect(
        runCli(home, ['hook', 'post-edit'], {
          env,
          input: edit(home, sessionId, file),
        }).code,
      ).toBe(0);

      expect(existsSync(join(repo, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(repo)).toContain('make a calculator');
      expect(existsSync(join(home, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(home)).not.toContain('make a calculator');
      expect(readAllArtifacts(pathsForRoot(home))).toEqual([]);
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('rerouting preserves an explicitly tracked HOME trail', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      const env = fakeHomeEnv(home, globalHome);
      expect(runCli(home, ['track', '--json'], { env }).code).toBe(0);
      enableAutoInit(globalHome);
      const repo = join(home, 'school', 'explicit-home-child');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const file = join(repo, 'index.ts');
      writeFileSync(file, 'export const value = 1;\n');
      const sessionId = 'explicit-home-reroute';

      runCli(home, ['hook', 'user-prompt'], {
        env,
        input: prompt(home, sessionId, 'work from home'),
      });
      runCli(home, ['hook', 'post-edit'], {
        env,
        input: edit(home, sessionId, file),
      });

      expect(existsSync(join(home, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(home)).not.toContain('work from home');
      expect(promptTexts(repo)).toContain('work from home');
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('a later nested-project edit moves an earlier parent projection', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      const workspace = join(home, 'school');
      mkdirSync(workspace, { recursive: true });
      expect(
        runCli(workspace, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      enableAutoInit(globalHome);
      const repo = join(workspace, 'parser');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const file = join(repo, 'parser.ts');
      writeFileSync(file, 'export const parse = () => {};\n');
      const env = fakeHomeEnv(home, globalHome);
      const sessionId = 'parent-to-project';

      expect(
        runCli(workspace, ['hook', 'user-prompt'], {
          env,
          input: prompt(workspace, sessionId, 'build a parser'),
        }).code,
      ).toBe(0);
      expect(promptTexts(workspace)).toContain('build a parser');

      expect(
        runCli(workspace, ['hook', 'post-edit'], {
          env,
          input: edit(workspace, sessionId, file),
        }).code,
      ).toBe(0);

      expect(promptTexts(repo)).toContain('build a parser');
      expect(promptTexts(workspace)).not.toContain('build a parser');
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('a nested project leaves the parent trail even when auto-init is off', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      const workspace = join(home, 'school');
      mkdirSync(workspace, { recursive: true });
      expect(
        runCli(workspace, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
      const repo = join(workspace, 'calculator');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const file = join(repo, 'calculator.ts');
      writeFileSync(file, 'export const answer = 42;\n');
      const env = fakeHomeEnv(home, globalHome);
      const sessionId = 'auto-init-off';

      expect(
        runCli(workspace, ['hook', 'user-prompt'], {
          env,
          input: prompt(workspace, sessionId, 'build a calculator'),
        }).code,
      ).toBe(0);
      expect(promptTexts(workspace)).toContain('build a calculator');

      expect(
        runCli(workspace, ['hook', 'post-edit'], {
          env,
          input: edit(workspace, sessionId, file),
        }).code,
      ).toBe(0);

      expect(promptTexts(workspace)).not.toContain('build a calculator');
      expect(existsSync(join(repo, '.showtail'))).toBe(false);
      const inbox = JSON.parse(
        runCli(workspace, ['inbox', '--all', '--json'], { env }).stdout,
      ).sessions;
      expect(inbox).toContainEqual(
        expect.objectContaining({
          nativeSessionId: sessionId,
          status: 'inbox',
          prompts: 1,
          edits: 1,
        }),
      );
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });

  test('work spanning two projects is removed from both trails and kept in the inbox', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      enableAutoInit(globalHome);
      const first = join(home, 'school', 'parser');
      const second = join(home, 'school', 'website');
      mkdirSync(join(first, '.git'), { recursive: true });
      mkdirSync(join(second, '.git'), { recursive: true });
      const firstFile = join(first, 'parser.ts');
      const secondFile = join(second, 'website.ts');
      writeFileSync(firstFile, 'export const parse = () => {};\n');
      writeFileSync(secondFile, 'export const render = () => {};\n');
      const env = fakeHomeEnv(home, globalHome);
      const sessionId = 'two-projects';

      expect(
        runCli(home, ['hook', 'user-prompt'], {
          env,
          input: prompt(home, sessionId, 'update both assignments'),
        }).code,
      ).toBe(0);
      expect(
        runCli(home, ['hook', 'post-edit'], {
          env,
          input: edit(home, sessionId, firstFile),
        }).code,
      ).toBe(0);
      expect(promptTexts(first)).toContain('update both assignments');

      expect(
        runCli(home, ['hook', 'post-edit'], {
          env,
          input: edit(home, sessionId, secondFile),
        }).code,
      ).toBe(0);

      expect(promptTexts(first)).not.toContain('update both assignments');
      expect(existsSync(join(second, '.showtail'))).toBe(false);
      const inbox = JSON.parse(
        runCli(home, ['inbox', '--all', '--json'], { env }).stdout,
      ).sessions;
      expect(inbox).toContainEqual(
        expect.objectContaining({
          nativeSessionId: sessionId,
          status: 'inbox',
          prompts: 1,
          edits: 2,
        }),
      );
    } finally {
      cleanup(home);
      cleanup(globalHome);
    }
  });
});
