import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  test('track and ensure treat HOME as a successful no-op', () => {
    const home = makeTempDir();
    const globalHome = makeTempDir();
    try {
      const env = fakeHomeEnv(home, globalHome);
      const tracked = runCli(home, ['track', '--json'], { env });
      const ensured = runCli(home, ['ensure', '--json'], { env });

      expect(tracked.code).toBe(0);
      expect(ensured.code).toBe(0);
      expect(JSON.parse(tracked.stdout)).toEqual({
        created: false,
        initialized: false,
        reason: 'home-directory',
        nextAction: 'open-project',
      });
      expect(JSON.parse(ensured.stdout)).toEqual({
        created: false,
        initialized: false,
        reason: 'home-directory',
        nextAction: 'open-project',
      });
      expect(existsSync(join(home, '.showtail'))).toBe(false);
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

  test('status and report do not fall back to a parent trail across a project boundary', () => {
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

      expect(status.code).toBe(2);
      expect(report.code).toBe(2);
      expect(status.stderr).toContain('No .showtail/ folder found');
      expect(report.stderr).toContain('No .showtail/ folder found');
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
      expect(
        runCli(home, ['track', '--json'], { env: envWithHome(globalHome) }).code,
      ).toBe(0);
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
      expect(promptTexts(home)).not.toContain('make a calculator');

      expect(
        runCli(home, ['hook', 'post-edit'], {
          env,
          input: edit(home, sessionId, file),
        }).code,
      ).toBe(0);

      expect(existsSync(join(repo, '.showtail', 'config.json'))).toBe(true);
      expect(promptTexts(repo)).toContain('make a calculator');
      expect(promptTexts(home)).not.toContain('make a calculator');
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
