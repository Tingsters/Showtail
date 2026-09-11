import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, envWithHome, makeTempDir, runCli } from './helpers.ts';

function run(cwd: string, args: string[], input = '') {
  return runCli(cwd, args, { input });
}

describe('--json output for the agent-driven loop', () => {
  test('init / start / report / end emit clean, parseable JSON', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Demo\n');

      let out = JSON.parse(run(dir, ['track', '--json']).stdout);
      expect(out.created).toBe(true);
      expect(out.root).toBeTruthy();

      out = JSON.parse(run(dir, ['start', '--json']).stdout);
      expect(out.sessionId).toMatch(/^ses_/);

      run(dir, ['log', '--type', 'prompt', '--text', 'help me out']);

      // Default (html) report: reports the html + markdown paths and a summary.
      out = JSON.parse(run(dir, ['report', '--json']).stdout);
      expect(out.reportPath).toContain('.html');
      expect(out.markdownPath).toContain('.md');
      expect(out.summary.events).toBeGreaterThan(0);

      // JSON-format report: single path, no markdown sidecar.
      out = JSON.parse(run(dir, ['report', '--format', 'json', '--json']).stdout);
      expect(out.format).toBe('json');
      expect(out.reportPath).toContain('.json');
      expect(out.markdownPath).toBeNull();
      const report = JSON.parse(readFileSync(out.reportPath, 'utf8'));
      expect(report.schemaVersion).toBe(2);
      expect(report.turns[0].events.map((event: { type: string }) => event.type)).toEqual(
        ['user_text'],
      );

      out = JSON.parse(run(dir, ['end', '--json']).stdout);
      expect(out.closed).toBe(true);
      expect(out.endedAt).toBeTruthy();

      // Ending again is a clean no-op in JSON form.
      out = JSON.parse(run(dir, ['end', '--json']).stdout);
      expect(out.closed).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('verify accepts an explicit project path and identifies the selected root', () => {
    const project = makeTempDir();
    const caller = makeTempDir();
    try {
      expect(run(project, ['track', '--json']).code).toBe(0);
      expect(run(project, ['start', '--json']).code).toBe(0);
      expect(
        run(project, ['log', '--type', 'prompt', '--text', 'verify this project']).code,
      ).toBe(0);

      const result = run(caller, ['verify', project, '--json']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: true,
          root: project,
          checks: expect.any(Array),
        }),
      );
    } finally {
      cleanup(project);
      cleanup(caller);
    }
  });

  test('verify rejects a missing explicit project path without falling back', () => {
    const caller = makeTempDir();
    try {
      expect(run(caller, ['track', '--json']).code).toBe(0);
      const missing = join(caller, 'does-not-exist');
      const result = run(caller, ['verify', missing, '--json']);

      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout);
      expect(payload).toEqual(
        expect.objectContaining({
          ok: false,
          errorCode: 'PATH_NOT_FOUND',
          nextAction: 'choose-existing-path',
          requestedRoot: missing,
          root: null,
          candidateRoot: null,
          candidates: [],
        }),
      );
      expect(payload.details).toEqual({
        requestedRoot: missing,
        root: null,
        candidateRoot: null,
        candidates: [],
      });
    } finally {
      cleanup(caller);
    }
  });

  test('project controls reject explicit blank paths instead of using cwd', () => {
    const caller = makeTempDir();
    try {
      expect(run(caller, ['track', '--json']).code).toBe(0);
      expect(run(caller, ['start', '--json']).code).toBe(0);
      expect(
        run(caller, ['log', '--type', 'prompt', '--text', 'do not report cwd']).code,
      ).toBe(0);

      for (const args of [
        ['status', '', '--json'],
        ['report', '   ', '--json', '--no-open'],
        ['verify', '', '--json'],
      ]) {
        const result = run(caller, args);
        expect(result.code).toBe(2);
        expect(result.stderr).toBe('');
        const payload = JSON.parse(result.stdout);
        expect(payload).toEqual(
          expect.objectContaining({
            ok: false,
            errorCode: 'PATH_NOT_FOUND',
            nextAction: 'choose-existing-path',
            requestedRoot: null,
            root: null,
            candidateRoot: null,
            candidates: [],
          }),
        );
      }
    } finally {
      cleanup(caller);
    }
  });

  test('JSON failures emit one object and no prose', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['verify', '--json']);
      expect(r.code).toBe(2);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          code: 2,
          errorCode: 'NO_PROJECT_TRAIL',
          message: expect.any(String),
          details: {},
          nextAction: expect.any(String),
        }),
      );
    } finally {
      cleanup(dir);
    }
  });

  test('Commander usage failures also emit one JSON object', () => {
    const dir = makeTempDir();
    try {
      const result = run(dir, ['status', '--bogus', '--json']);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          code: 1,
          errorCode: 'CLI_USAGE_ERROR',
          message: expect.any(String),
          nextAction: 'run-command-help',
        }),
      );
    } finally {
      cleanup(dir);
    }
  });

  test('first-run setup stays silent around a JSON failure', () => {
    const dir = makeTempDir();
    const home = makeTempDir();
    try {
      const env = envWithHome(home);
      delete env.SHOWTAIL_DISABLE_FIRST_RUN;

      const r = runCli(dir, ['verify', '--json'], { env });

      expect(r.code).toBe(2);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          code: 2,
          errorCode: 'NO_PROJECT_TRAIL',
        }),
      );
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
