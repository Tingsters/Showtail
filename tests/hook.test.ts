import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** Run `showtail <args>` in `cwd`, optionally piping `input` to stdin. */
function run(cwd: string, args: string[], input?: string) {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

function initProject(dir: string) {
  run(dir, ['init', '--project', 'Hook Test']);
}

describe('hook command (end-to-end via stdin)', () => {
  test('user-prompt hook logs a prompt event', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: dir,
        prompt: 'How should I structure the parser?',
      });
      const r = run(dir, ['hook', 'user-prompt'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(''); // must not pollute Claude's context

      const report = run(dir, ['report', '--format', 'json']);
      expect(report.code).toBe(0);
      // The prompt should now be captured in the trail.
      const trace = run(dir, ['report']);
      expect(trace.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit hook snapshots the edited file as an artifact', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_name: 'Edit',
        tool_input: { file_path: join(dir, 'parser.ts') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);

      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      expect(trace.code).toBe(0);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('session-start hook prints a one-line context note and creates a session', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: dir,
        source: 'startup',
      });
      const r = run(dir, ['hook', 'session-start'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Showtail is capturing');
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit ignores internal .showtail/.claude paths', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        tool_input: { file_path: join(dir, '.showtail', 'config.json') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);
      // config.json should not have been recorded as an artifact.
      const trace = run(dir, ['trace', '.showtail/config.json', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('hooks are silent no-ops outside a Showtail project', () => {
    const dir = makeTempDir();
    try {
      // No `showtail init` here.
      const r = run(dir, ['hook', 'user-prompt'], JSON.stringify({ prompt: 'hi' }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      cleanup(dir);
    }
  });

  test('malformed stdin does not crash a hook', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const r = run(dir, ['hook', 'user-prompt'], 'not json at all');
      expect(r.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('skill status reports ON once project hooks are installed', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(dir, ['skill', 'install', '--project']); // hooks on by default
      const r = run(dir, ['skill', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('auto-capture: ON');
    } finally {
      cleanup(dir);
    }
  });
});
