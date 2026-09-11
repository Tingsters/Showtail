import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_VERSION,
  readConfig,
  pathsForRoot,
  writeConfig,
} from '../src/core/storage.ts';
import { cleanup, envWithHome, makeTempDir, runCli } from './helpers.ts';

describe('project selector CLI', () => {
  test('projects exposes the stable compact resolution contract', () => {
    const home = makeTempDir();
    const caller = makeTempDir();
    const word = makeTempDir();
    const fairy = makeTempDir();
    try {
      const env = envWithHome(home);
      expect(runCli(word, ['track', '--json'], { env }).code).toBe(0);
      expect(runCli(fairy, ['track', '--json'], { env }).code).toBe(0);

      const wordPaths = pathsForRoot(word);
      const wordConfig = readConfig(wordPaths);
      wordConfig.project = 'Word Sparkle';
      wordConfig.anchorKind = 'edit';
      wordConfig.initialization = { mode: 'automatic', evidence: 'edit' };
      writeConfig(wordPaths, wordConfig);

      const fairyPaths = pathsForRoot(fairy);
      const fairyConfig = readConfig(fairyPaths);
      fairyConfig.project = 'Fairy Sparkle';
      fairyConfig.anchorKind = 'edit';
      fairyConfig.initialization = { mode: 'automatic', evidence: 'edit' };
      writeConfig(fairyPaths, fairyConfig);
      const globalConfigPath = join(home, 'config.json');
      const configBeforeResolution = readFileSync(globalConfigPath, 'utf8');

      const result = runCli(caller, ['projects', 'my sparkle word game', '--json'], {
        env,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const resolution = JSON.parse(result.stdout);
      expect(resolution).toEqual({
        schemaVersion: 1,
        state: 'selected',
        selector: 'my sparkle word game',
        selection: {
          trailId: wordConfig.trailId,
          root: word,
          displayName: 'Word Sparkle',
          mode: 'corroborated',
          evidence: ['complete-name', 'edit-backed-provenance', 'live-config'],
          crossWorkspace: true,
        },
      });
      expect(readFileSync(globalConfigPath, 'utf8')).toBe(configBeforeResolution);

      const ambiguous = runCli(caller, ['projects', 'sparkle game', '--json'], {
        env,
      });
      expect(ambiguous.code).toBe(0);
      const ambiguousResolution = JSON.parse(ambiguous.stdout);
      expect(ambiguousResolution).toMatchObject({
        schemaVersion: 1,
        state: 'ambiguous',
        selector: 'sparkle game',
      });
      expect(
        ambiguousResolution.candidates
          .map((candidate: { trailId: string }) => candidate.trailId)
          .sort(),
      ).toEqual([fairyConfig.trailId, wordConfig.trailId].sort());
      expect(readFileSync(globalConfigPath, 'utf8')).toBe(configBeforeResolution);
    } finally {
      cleanup(home);
      cleanup(caller);
      cleanup(word);
      cleanup(fairy);
    }
  });

  test('stale Showtail workspace resolves Word Sparkle and reports it once', () => {
    const home = makeTempDir();
    const word = makeTempDir();
    const fairy = makeTempDir();
    const stale = makeTempDir();
    try {
      const env = envWithHome(home);
      const invocations: string[][] = [];
      const invoke = (cwd: string, args: string[]) => {
        invocations.push(args);
        return runCli(cwd, args, { env });
      };
      const configureProject = (root: string, project: string, editBacked: boolean) => {
        const paths = pathsForRoot(root);
        const config = readConfig(paths);
        config.project = project;
        if (editBacked) {
          config.anchorKind = 'edit';
          config.initialization = { mode: 'automatic', evidence: 'edit' };
        }
        writeConfig(paths, config);
        return config;
      };
      const reportsAt = (root: string): string[] => {
        const reports = join(root, '.showtail', 'reports');
        return existsSync(reports) ? readdirSync(reports).sort() : [];
      };

      expect(invoke(word, ['track', '--json']).code).toBe(0);
      expect(invoke(fairy, ['track', '--json']).code).toBe(0);
      expect(invoke(stale, ['track', '--json']).code).toBe(0);
      const wordConfig = configureProject(word, 'Word Sparkle', true);
      configureProject(fairy, 'Fairy Sparkle', true);
      configureProject(stale, 'Showtail-self-update', false);

      const staleReports = join(stale, '.showtail', 'reports');
      const staleReport = join(staleReports, 'existing-report.html');
      mkdirSync(staleReports, { recursive: true });
      writeFileSync(staleReport, 'keep this stale report', 'utf8');
      const wordReportsBefore = reportsAt(word);
      const fairyReportsBefore = reportsAt(fairy);
      const staleReportsBefore = reportsAt(stale);

      const resolved = invoke(stale, ['projects', 'sparkle word game', '--json']);
      expect(resolved.code).toBe(0);
      expect(resolved.stderr).toBe('');
      const resolution = JSON.parse(resolved.stdout);
      expect(resolution).toEqual({
        schemaVersion: 1,
        state: 'selected',
        selector: 'sparkle word game',
        selection: {
          trailId: wordConfig.trailId,
          root: word,
          displayName: 'Word Sparkle',
          mode: 'corroborated',
          evidence: ['complete-name', 'edit-backed-provenance', 'live-config'],
          crossWorkspace: true,
        },
      });

      const report = invoke(stale, [
        'report',
        '--project',
        resolution.selection.trailId,
        '--json',
        '--no-sync',
        '--no-open',
      ]);
      expect(invocations.filter(([command]) => command === 'report')).toHaveLength(1);
      expect(report.code).toBe(0);
      expect(report.stderr).toBe('');
      const payload = JSON.parse(report.stdout);
      expect(payload).toMatchObject({
        ok: true,
        root: word,
        trailId: wordConfig.trailId,
      });
      expect(payload.reportPath).toContain(join(word, '.showtail', 'reports'));
      expect(existsSync(payload.reportPath)).toBe(true);
      expect(reportsAt(word).length).toBeGreaterThan(wordReportsBefore.length);
      expect(reportsAt(fairy)).toEqual(fairyReportsBefore);
      expect(reportsAt(stale)).toEqual(staleReportsBefore);
      expect(readFileSync(staleReport, 'utf8')).toBe('keep this stale report');
    } finally {
      cleanup(home);
      cleanup(word);
      cleanup(fairy);
      cleanup(stale);
    }
  });

  test('report, status, and verify target a trail id without cwd fallback', () => {
    const home = makeTempDir();
    const project = makeTempDir();
    const caller = makeTempDir();
    try {
      const env = envWithHome(home);
      expect(runCli(project, ['track', '--json'], { env }).code).toBe(0);
      const trailId = readConfig(pathsForRoot(project)).trailId!;

      const report = runCli(
        caller,
        ['report', '--project', trailId, '--json', '--no-sync', '--no-open'],
        { env },
      );
      expect(report.code).toBe(0);
      const reportJson = JSON.parse(report.stdout);
      expect(reportJson).toMatchObject({
        ok: true,
        root: project,
        trailId,
        routing: expect.any(Object),
      });
      expect(reportJson).not.toHaveProperty('pendingRanges');
      expect(existsSync(reportJson.reportPath)).toBe(true);
      const globalConfigPath = join(home, 'config.json');
      const configAfterReport = readFileSync(globalConfigPath, 'utf8');

      const status = runCli(caller, ['status', '--project', trailId, '--json'], { env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        initialized: true,
        root: project,
        trailId,
        pending: expect.any(Object),
      });
      expect(readFileSync(globalConfigPath, 'utf8')).toBe(configAfterReport);

      const verify = runCli(caller, ['verify', '--project', trailId, '--json'], { env });
      expect(verify.code).toBe(0);
      const verifyJson = JSON.parse(verify.stdout);
      expect(verifyJson).toMatchObject({
        ok: true,
        root: project,
        trailId,
      });
      expect(verifyJson.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detailsCount: expect.any(Number) }),
        ]),
      );
      expect(readFileSync(globalConfigPath, 'utf8')).toBe(configAfterReport);
    } finally {
      cleanup(home);
      cleanup(project);
      cleanup(caller);
    }
  });

  test('explicit report refuses a reports-directory junction outside the project', () => {
    const home = makeTempDir();
    const caller = makeTempDir();
    const project = makeTempDir();
    const outside = makeTempDir();
    const reportsDir = join(project, '.showtail', 'reports');
    let linked = false;
    try {
      const env = envWithHome(home);
      expect(runCli(project, ['track', '--json'], { env }).code).toBe(0);
      rmSync(reportsDir, { recursive: true });
      symlinkSync(outside, reportsDir, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;

      const result = runCli(
        caller,
        ['report', '--project', project, '--json', '--no-sync', '--no-open'],
        { env },
      );

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        errorCode: 'REPORT_PATH_OUTSIDE_PROJECT',
      });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      if (linked && existsSync(reportsDir)) unlinkSync(reportsDir);
      cleanup(home);
      cleanup(caller);
      cleanup(project);
      cleanup(outside);
    }
  });

  test('verbose JSON restores routing arrays and unknown selectors never report cwd', () => {
    const home = makeTempDir();
    const caller = makeTempDir();
    try {
      const env = envWithHome(home);
      expect(runCli(caller, ['track', '--json'], { env }).code).toBe(0);
      const reportsDir = join(caller, '.showtail', 'reports');
      const reportsBefore = existsSync(reportsDir) ? readdirSync(reportsDir) : [];

      const missing = runCli(
        caller,
        ['report', '--project', 'trl_missing', '--json', '--no-open'],
        { env },
      );
      expect(missing.code).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        ok: false,
        errorCode: 'PROJECT_NOT_FOUND',
        details: {
          resolution: {
            schemaVersion: 1,
            state: 'not-found',
            selector: 'trl_missing',
          },
        },
      });
      expect(readdirSync(reportsDir)).toEqual(reportsBefore);

      const trailId = readConfig(pathsForRoot(caller)).trailId!;
      const verbose = runCli(
        caller,
        [
          'report',
          '--project',
          trailId,
          '--json',
          '--verbose-json',
          '--no-sync',
          '--no-open',
        ],
        { env },
      );
      expect(verbose.code).toBe(0);
      const payload = JSON.parse(verbose.stdout);
      expect(payload.pendingRanges).toEqual([]);
      expect(payload.claimedSessions).toEqual([]);
      expect(readFileSync(payload.reportPath, 'utf8')).toBeTruthy();
    } finally {
      cleanup(home);
      cleanup(caller);
    }
  });

  test('compact selection errors bound large candidate lists while verbose JSON keeps them', () => {
    const home = makeTempDir();
    const caller = makeTempDir();
    const projects: string[] = [];
    try {
      const knownProjects = Array.from({ length: 60 }, (_, index) => {
        const root = makeTempDir();
        projects.push(root);
        const trailId = `trl_shared_${index}`;
        mkdirSync(join(root, '.showtail'), { recursive: true });
        writeFileSync(
          join(root, '.showtail', 'config.json'),
          `${JSON.stringify({
            version: CONFIG_VERSION,
            project: `Shared Project ${index}`,
            createdAt: '2026-09-11T00:00:00.000Z',
            anchor: root,
            anchorKind: 'explicit',
            trailId,
            settings: { git: false },
          })}\n`,
          'utf8',
        );
        return {
          trailId,
          path: root,
          lastSeenAt: '2026-09-11T00:00:00.000Z',
        };
      });
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.json'),
        `${JSON.stringify({ version: 1, knownProjects })}\n`,
        'utf8',
      );
      const env = envWithHome(home);

      const compact = runCli(
        caller,
        ['report', '--project', 'shared project', '--json', '--no-open'],
        { env },
      );
      expect(compact.code).toBe(2);
      expect(Buffer.byteLength(compact.stdout, 'utf8')).toBeLessThan(8_000);
      const compactPayload = JSON.parse(compact.stdout);
      expect(compactPayload.details.resolution).toMatchObject({
        state: 'ambiguous',
        candidateCount: 60,
        candidatesTruncated: true,
      });
      expect(compactPayload.details.resolution.candidates.length).toBeLessThan(60);

      const verbose = runCli(
        caller,
        [
          'report',
          '--project',
          'shared project',
          '--json',
          '--verbose-json',
          '--no-open',
        ],
        { env },
      );
      expect(verbose.code).toBe(2);
      expect(JSON.parse(verbose.stdout).details.resolution.candidates).toHaveLength(60);
    } finally {
      cleanup(home);
      cleanup(caller);
      for (const project of projects) cleanup(project);
    }
  });
});
