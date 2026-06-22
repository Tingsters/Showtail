import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup,
  enableAutoInit as setAutoInit,
  envWithHome as envWith,
  makeTempDir,
  runCli,
} from './helpers.ts';

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv, input = '') {
  return runCli(cwd, args, { env, input });
}

function enableAutoInit(home: string): void {
  setAutoInit(home, '2026-06-20T00:00:00.000Z');
}

describe('capabilities', () => {
  test('does not throw in an untracked folder and tells an agent to run setup', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const r = run(dir, ['capabilities', '--json'], envWith(home));
      expect(r.code).toBe(0); // never NotInitialized — must not call requirePaths
      const out = JSON.parse(r.stdout);
      expect(out.initialized).toBe(false);
      expect(out.autoInit).toBe(false);
      expect(out.nextAction).toBe('run-setup');
      expect(Array.isArray(out.commands)).toBe(true);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('with auto-init on but no work yet, next action is to work', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const r = run(dir, ['capabilities', '--json'], envWith(home));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.autoInit).toBe(true);
      expect(out.setupCompleted).toBe(true);
      expect(out.nextAction).toBe('work');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('after a prompt is captured, next action is to report', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');
      enableAutoInit(home);
      const env = envWith(home);
      const payload = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: dir,
        prompt: 'write a function',
        session_id: 's1',
      });
      run(dir, ['hook', 'user-prompt'], env, payload);

      const r = run(dir, ['capabilities', '--json'], env);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.initialized).toBe(true);
      expect(out.anchorKind).not.toBeNull();
      expect(out.session?.events).toBe(1);
      expect(out.nextAction).toBe('report');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
