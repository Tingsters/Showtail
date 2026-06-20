import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the real CLI (through bun) in a given directory. */
function run(cwd: string, args: string[]): RunResult {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status ?? 0,
  };
}

describe('cli (end-to-end acceptance sequence)', () => {
  test('runs the full documented workflow successfully', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Demo Project\n');

      // init
      let r = run(dir, ['init', '--project', 'Demo']);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);

      // start
      r = run(dir, ['start']);
      expect(r.code).toBe(0);

      // log prompt
      r = run(dir, ['log', '--type', 'prompt', '--text', 'Help me plan the project']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Logged prompt');

      // log decision
      r = run(dir, [
        'log',
        '--type',
        'decision',
        '--text',
        'I implemented the CLI first',
      ]);
      expect(r.code).toBe(0);

      // artifact
      r = run(dir, ['artifact', 'README.md']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Recorded artifact: README.md');

      // trace
      r = run(dir, ['trace', 'README.md']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Provenance trail for: README.md');

      // trace --format json
      r = run(dir, ['trace', 'README.md', '--format', 'json']);
      expect(r.code).toBe(0);
      const traced = JSON.parse(r.stdout);
      expect(traced.path).toBe('README.md');
      expect(traced.artifacts.length).toBe(1);

      // report
      r = run(dir, ['report']);
      expect(r.code).toBe(0);
      const reports = readdirSync(join(dir, '.showtail', 'reports'));
      expect(reports.some((f) => f.endsWith('.md'))).toBe(true);

      // report --format json
      r = run(dir, ['report', '--format', 'json']);
      expect(r.code).toBe(0);
      expect(
        readdirSync(join(dir, '.showtail', 'reports')).some((f) => f.endsWith('.json')),
      ).toBe(true);

      // verify
      r = run(dir, ['verify']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('All checks passed.');
    } finally {
      cleanup(dir);
    }
  });

  test('log with an invalid type exits non-zero with a helpful message', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init']);
      const r = run(dir, ['log', '--type', 'banana', '--text', 'hi']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('valid --type');
    } finally {
      cleanup(dir);
    }
  });

  test('commands before init give a clear not-initialized error', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['start']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('showtail init');
    } finally {
      cleanup(dir);
    }
  });

  test('text can be piped via stdin when --text is omitted', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init']);
      const res = spawnSync(
        process.execPath,
        ['run', CLI, 'log', '--type', 'reflection'],
        { cwd: dir, encoding: 'utf8', input: 'I learned how parsers tokenize input.' },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Logged reflection');
    } finally {
      cleanup(dir);
    }
  });

  test('status, sessions, and end report the session lifecycle', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['init']);
      run(dir, ['start', '--label', 'lap one']);
      run(dir, ['log', '--type', 'prompt', '--text', 'plan it']);

      // status: open session with its event count and a connected-tools section
      let r = run(dir, ['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lap one');
      expect(r.stdout).toContain('1 event');
      expect(r.stdout).toContain('Connected tools');

      // status --json: machine-readable, exposes hooksActive for the skill
      r = run(dir, ['status', '--json']);
      expect(r.code).toBe(0);
      const status = JSON.parse(r.stdout);
      expect(status.session.label).toBe('lap one');
      expect(status.session.events).toBe(1);
      expect(typeof status.hooksActive).toBe('boolean');

      // sessions: lists the one session and marks it current
      r = run(dir, ['sessions']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lap one');
      expect(r.stdout).toContain('current session');

      // end: closes it; a following status reports no open session
      r = run(dir, ['end']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Closed session');
      r = run(dir, ['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No open session');
    } finally {
      cleanup(dir);
    }
  });

  test('--help groups commands under labeled sections', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['--help']);
      expect(r.code).toBe(0);
      for (const heading of [
        'Get started:',
        'Capture your work:',
        'Review your trail:',
        'Connect your tools:',
      ]) {
        expect(r.stdout).toContain(heading);
      }
      // The unified integration verbs replace the old per-tool groups.
      expect(r.stdout).toContain('connect');
      expect(r.stdout).toContain('disconnect');
    } finally {
      cleanup(dir);
    }
  });
});
