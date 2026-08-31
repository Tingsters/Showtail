import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli } from './helpers.ts';

/** Run the real CLI (through bun) in a given directory. */
const run = runCli;

describe('cli (end-to-end acceptance sequence)', () => {
  test('runs the full documented workflow successfully', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Demo Project\n');

      // init
      let r = run(dir, ['track', '--project', 'Demo']);
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, '.showtail', 'config.json'))).toBe(true);

      // start
      r = run(dir, ['start']);
      expect(r.code).toBe(0);

      // log prompt
      r = run(dir, ['log', '--type', 'prompt', '--text', 'Help me plan the project']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Logged prompt');

      // log an AI response
      r = run(dir, [
        'log',
        '--type',
        'ai_output',
        '--text',
        'Start with the CLI entry point',
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
      run(dir, ['track']);
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
      expect(r.stderr).toContain('showtail track');
    } finally {
      cleanup(dir);
    }
  });

  test('text can be piped via stdin when --text is omitted', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['track']);
      const res = run(dir, ['log', '--type', 'prompt'], {
        input: 'How do parsers tokenize input?',
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Logged prompt');
    } finally {
      cleanup(dir);
    }
  });

  test('status, sessions, and end report the session lifecycle', () => {
    const dir = makeTempDir();
    try {
      run(dir, ['track']);
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
        'Capture your work:',
        'Review your trail:',
        'Connect your tools:',
        'Maintain Showtail:',
        // Tracking is automatic now, so there is no "Get started" step; the manual
        // setup/track commands live under this optional group instead.
        'Manage tracking (optional):',
      ]) {
        expect(r.stdout).toContain(heading);
      }
      // Tracking turns on automatically — no getting-started commands are shown.
      expect(r.stdout).not.toContain('Get started:');
      // The unified integration verbs replace the old per-tool groups.
      expect(r.stdout).toContain('connect');
      expect(r.stdout).toContain('disconnect');
      expect(r.stdout).toContain('upgrade');
      // `matrix` is a maintainer/informational command — hidden from help, still runnable.
      expect(r.stdout).not.toMatch(/^\s+matrix\b/m);
      expect(run(dir, ['matrix', '--json']).code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('upgrade refuses a Bun/source invocation before making a network request', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['upgrade']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('updates standalone installs only');
    } finally {
      cleanup(dir);
    }
  });
});
