import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup,
  enableAutoInit,
  envWithHome as envWith,
  makeTempDir,
  runCli,
} from './helpers.ts';

function run(cwd: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return runCli(cwd, args, { input, env });
}

function userPrompt(cwd: string, prompt = 'help me build a parser', sessionId = 's1') {
  return JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
    session_id: sessionId,
  });
}

/** Event count of the current session, via `status --json` (0 if uninitialized). */
function promptCount(cwd: string, env: NodeJS.ProcessEnv): number {
  const res = run(cwd, ['status', '--json'], '', env);
  if (res.code !== 0) return 0;
  try {
    return JSON.parse(res.stdout).session?.events ?? 0;
  } catch {
    return 0;
  }
}

describe('automatic init on first AI use', () => {
  test('opt-in ON: a user-prompt in a dev folder creates the trail and logs the prompt', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n'); // marks a dev workspace
      enableAutoInit(home);
      const env = envWith(home);

      const r = run(dir, ['hook', 'user-prompt'], userPrompt(dir), env);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);
      expect(promptCount(dir, env)).toBe(1);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('opt-in ON: a prompt from a git subdir anchors the trail at the repo root', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      expect(spawnSync('git', ['init'], { cwd: dir }).status).toBe(0);
      const sub = join(dir, 'src', 'deep');
      mkdirSync(sub, { recursive: true });
      enableAutoInit(home);
      const env = envWith(home);

      const r = run(sub, ['hook', 'user-prompt'], userPrompt(sub), env);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);
      expect(existsSync(join(sub, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('opt-in OFF: the same prompt creates nothing', () => {
    const dir = makeTempDir();
    const home = makeTempDir(); // no config written → auto-init disabled
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');
      const env = envWith(home);

      const r = run(dir, ['hook', 'user-prompt'], userPrompt(dir), env);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('opt-in ON but folder is not a project: creates nothing', () => {
    const dir = makeTempDir(); // empty, no markers, not a git repo
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWith(home);

      const r = run(dir, ['hook', 'user-prompt'], userPrompt(dir), env);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('opt-in ON: a stray post-edit (no task start) never creates a trail', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;\n');
      enableAutoInit(home);
      const env = envWith(home);

      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        session_id: 's1',
        tool_input: { file_path: join(dir, 'parser.ts') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload, env);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail'))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
