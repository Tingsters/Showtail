import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, runCli } from './helpers.ts';

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

  test('a command needing a project exits with code 2 (not initialized)', () => {
    const dir = makeTempDir();
    try {
      const r = run(dir, ['status', '--json']);
      expect(r.code).toBe(2);
    } finally {
      cleanup(dir);
    }
  });
});
