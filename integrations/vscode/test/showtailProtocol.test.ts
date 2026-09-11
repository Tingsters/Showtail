import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHOWTAIL_PROJECT_CONTROL_PROTOCOL,
  SHOWTAIL_VSCODE_HOOK_PROTOCOL,
  antigravitySaveReconcileInput,
  automaticCaptureSucceeded,
  captureConsentFromStatus,
  captureStatusArgs,
  chatCommandRequiresProject,
  chatSessionId,
  copilotImportArgs,
  copilotManagedRefreshArgs,
  createProjectControlMarker,
  extensionHookArgs,
  extensionHookPayload,
  latestProjectControlClaimId,
  latestReportProjectControlClaimId,
  managedRefreshSucceeded,
  parseOptionalProjectPath,
  parseProjectCommandResult,
  parseProjectControlMarker,
  parseProjectResolution,
  parseReportResult,
  parseResolvedProjectCommandResult,
  parseStoredProjectControlClaims,
  pendingRangesMarkdown,
  pendingRangesNotice,
  projectCommandResultMarkdown,
  projectsArgs,
  reportArgs,
  reportPathFromClaim,
  reportRecoveryNotice,
  reportResultMarkdown,
  selectProjectPath,
  statusArgs,
  verifyArgs,
} from '../src/showtailProtocol';

const pendingRangeFixture = {
  id: 'copilot-session/range-2',
  sessionId: 'copilot-session',
  rangeId: 'range-2',
  startedAt: '2026-09-10T12:00:00.000Z',
  lastSeenAt: '2026-09-10T12:04:00.000Z',
  firstPrompt: null,
  lastPrompt: 'Move the game.',
  prompts: 2,
  edits: 3,
  reason: 'multiple project candidates',
  candidates: ['/course/game', '/course/old-game'],
  ignoredByOlderExtensions: true,
};

const selectedProject = {
  trailId: 'trl_word_sparkle',
  root: 'C:\\Users\\student\\word_sparkle',
  displayName: 'Word Sparkle',
  mode: 'corroborated' as const,
  evidence: ['complete-name', 'edit-provenance'],
};

describe('VS Code extension hook protocol', () => {
  test('keeps process cwd separate from a folderless project context', () => {
    const payload = extensionHookPayload({
      sessionId: 'chat-1',
      cwd: 'C:\\Users\\student',
      projectCwd: null,
      workspacePaths: [],
      prompt: 'Plan the project.',
      timestamp: '2026-09-10T12:00:00.000Z',
    });

    expect(payload).toEqual({
      showtailExtension: SHOWTAIL_VSCODE_HOOK_PROTOCOL,
      session_id: 'chat-1',
      cwd: 'C:\\Users\\student',
      projectCwd: null,
      workspacePaths: [],
      prompt: 'Plan the project.',
      timestamp: '2026-09-10T12:00:00.000Z',
    });
  });

  test('derives the native session id from current and legacy transcript files', () => {
    expect(chatSessionId('/tmp/chatSessions/session-a.jsonl')).toBe('session-a');
    expect(chatSessionId('/tmp/chatSessions/session-b.json')).toBe('session-b');
  });

  test('allows folderless prompts and status but scopes trail commands to a project', () => {
    expect(chatCommandRequiresProject(undefined)).toBe(false);
    expect(chatCommandRequiresProject('status')).toBe(false);
    expect(chatCommandRequiresProject('report')).toBe(true);
    expect(chatCommandRequiresProject('open_report')).toBe(true);
    expect(chatCommandRequiresProject('verify')).toBe(true);
    expect(chatCommandRequiresProject('trace')).toBe(true);
  });

  test('reconciles Antigravity saves only after a save context exists', () => {
    expect(antigravitySaveReconcileInput('extension-session', undefined)).toBeUndefined();
    expect(
      antigravitySaveReconcileInput('extension-session', {
        cwd: '/project',
        projectCwd: '/project',
        workspacePaths: ['/project'],
      }),
    ).toEqual({
      sessionId: 'extension-session',
      cwd: '/project',
      projectCwd: '/project',
      workspacePaths: ['/project'],
    });
  });

  test('uses ledger-first hook/import commands and explicit project paths', () => {
    expect(captureStatusArgs('github-copilot')).toEqual([
      'status',
      '--json',
      '--tool',
      'github-copilot',
    ]);
    expect(captureStatusArgs('antigravity-ide')).toEqual([
      'status',
      '--json',
      '--tool',
      'antigravity-ide',
    ]);
    expect(extensionHookArgs('github-copilot', 'post-edit')).toEqual([
      'hook',
      'post-edit',
      '--tool',
      'github-copilot',
    ]);
    expect(extensionHookArgs('antigravity-ide', 'post-edit')).toEqual([
      'hook',
      'post-edit',
      '--tool',
      'antigravity-ide',
    ]);
    expect(copilotImportArgs('/tmp/session.jsonl')).toEqual([
      'import',
      'copilot',
      '--file',
      '/tmp/session.jsonl',
      '--auto',
      '--quiet',
    ]);
    expect(copilotManagedRefreshArgs()).toEqual([
      'connect',
      'copilot',
      '--no-extension',
      '--managed-refresh',
    ]);
    expect(copilotManagedRefreshArgs(true)).toEqual([
      'connect',
      'copilot',
      '--no-extension',
      '--managed-refresh',
      '--force',
    ]);
    expect(projectsArgs()).toEqual(['projects', '--json']);
    expect(projectsArgs('sparkle word game')).toEqual([
      'projects',
      'sparkle word game',
      '--json',
    ]);
    expect(reportArgs('trl_game')).toEqual([
      'report',
      '--project',
      'trl_game',
      '--json',
      '--no-open',
    ]);
    expect(verifyArgs('trl_game')).toEqual(['verify', '--project', 'trl_game', '--json']);
    expect(statusArgs('trl_game', 'github-copilot')).toEqual([
      'status',
      '--project',
      'trl_game',
      '--json',
      '--tool',
      'github-copilot',
    ]);
    expect(statusArgs('trl_game', 'antigravity-ide')).toEqual([
      'status',
      '--project',
      'trl_game',
      '--json',
      '--tool',
      'antigravity-ide',
    ]);
  });

  test('keys capture consent only on the explicit machine-wide stop boolean', () => {
    expect(
      captureConsentFromStatus({
        stdout: JSON.stringify({
          captureGloballyDisabled: false,
          capture: { mode: 'disconnected' },
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toBe('enabled');
    expect(
      captureConsentFromStatus({
        stdout: JSON.stringify({
          captureGloballyDisabled: true,
          capture: { mode: 'automatic' },
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toBe('disabled');
    expect(
      captureConsentFromStatus({
        stdout: JSON.stringify({ capture: { mode: 'automatic' } }),
        stderr: '',
        exitCode: 0,
      }),
    ).toBe('unknown');
    expect(
      captureConsentFromStatus({
        stdout: JSON.stringify({ captureGloballyDisabled: 'false' }),
        stderr: '',
        exitCode: 0,
      }),
    ).toBe('unknown');
    expect(captureConsentFromStatus({ stdout: '{broken', stderr: '', exitCode: 0 })).toBe(
      'unknown',
    );
    expect(
      captureConsentFromStatus({ stdout: '', stderr: 'not found', exitCode: 1 }),
    ).toBe('unknown');
  });

  test('background completion fails closed across disconnect races', () => {
    const ok = { stdout: '', stderr: '', exitCode: 0 };
    const refused = { stdout: '', stderr: 'disabled', exitCode: 4 };

    expect(automaticCaptureSucceeded(ok, 'enabled')).toBe(true);
    expect(automaticCaptureSucceeded(ok, 'disabled')).toBe(false);
    expect(automaticCaptureSucceeded(ok, 'unknown')).toBe(false);
    expect(automaticCaptureSucceeded(refused, 'enabled')).toBe(false);

    expect(managedRefreshSucceeded(ok, true, 'enabled')).toBe(true);
    expect(managedRefreshSucceeded(ok, false, 'enabled')).toBe(false);
    expect(managedRefreshSucceeded(ok, true, 'disabled')).toBe(false);
    expect(managedRefreshSucceeded(refused, true, 'enabled')).toBe(false);
  });
});

describe('metadata-first project control', () => {
  test('parses one corroborated selection with stable identity metadata', () => {
    expect(
      parseProjectResolution({
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'selected',
          selector: 'sparkle word game',
          selection: {
            ...selectedProject,
            crossWorkspace: true,
          },
          candidates: [],
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toEqual({
      schemaVersion: 1,
      state: 'selected',
      selector: 'sparkle word game',
      selection: { ...selectedProject, crossWorkspace: true },
      candidates: [],
    });
  });

  test('turns a catalog response into a local-choice resolution', () => {
    expect(
      parseProjectResolution({
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'catalog',
          candidates: [
            {
              trailId: selectedProject.trailId,
              root: selectedProject.root,
              displayName: selectedProject.displayName,
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toEqual({
      schemaVersion: 1,
      state: 'ambiguous',
      candidates: [
        {
          ...selectedProject,
          evidence: [],
        },
      ],
    });
  });

  test('keeps a confirmation candidate but refuses an invalid selected identity', () => {
    expect(
      parseProjectResolution({
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'confirmation-required',
          selection: selectedProject,
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({
      state: 'confirmation-required',
      candidates: [selectedProject],
    });

    expect(
      parseProjectResolution({
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'selected',
          selection: { ...selectedProject, root: 'relative/project' },
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({
      state: 'not-found',
      message: expect.stringContaining('valid trail identity'),
    });

    expect(
      parseProjectResolution({
        stdout: JSON.stringify({
          schemaVersion: 2,
          state: 'selected',
          selection: selectedProject,
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({
      state: 'not-found',
      message: expect.stringContaining('unsupported'),
    });
  });

  test('fails closed on unversioned, failed, or malformed selected results', () => {
    const selected = {
      schemaVersion: 1,
      state: 'selected',
      selection: selectedProject,
    };

    expect(
      parseProjectResolution({
        stdout: JSON.stringify({ ...selected, schemaVersion: undefined }),
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({
      state: 'not-found',
      message: expect.stringContaining('unsupported'),
    });

    expect(
      parseProjectResolution({
        stdout: JSON.stringify(selected),
        stderr: 'legacy command failed',
        exitCode: 1,
      }),
    ).toMatchObject({ state: 'not-found', candidates: [] });

    for (const selection of [
      { ...selectedProject, mode: undefined },
      { ...selectedProject, mode: 'trusted' },
      { ...selectedProject, evidence: [] },
      { ...selectedProject, evidence: ['live-config', 'bad\nvalue'] },
    ]) {
      expect(
        parseProjectResolution({
          stdout: JSON.stringify({ ...selected, selection }),
          stderr: '',
          exitCode: 0,
        }),
      ).toMatchObject({
        state: 'not-found',
        message: expect.stringContaining('valid trail identity'),
      });
    }
  });

  test('requires status and verify to echo the resolved trail and root', () => {
    const matching = parseResolvedProjectCommandResult(
      {
        stdout: JSON.stringify({
          ok: true,
          trailId: selectedProject.trailId,
          root: selectedProject.root,
          verified: true,
        }),
        stderr: '',
        exitCode: 0,
      },
      selectedProject,
    );
    expect(matching).toMatchObject({
      ok: true,
      trailId: selectedProject.trailId,
      root: selectedProject.root,
    });

    const wrongTrail = parseResolvedProjectCommandResult(
      {
        stdout: JSON.stringify({
          ok: true,
          trailId: 'trl_stale_workspace',
          root: selectedProject.root,
        }),
        stderr: '',
        exitCode: 0,
      },
      selectedProject,
    );
    expect(wrongTrail.ok).toBe(false);
    expect(wrongTrail.text).toContain('not the selected trail');

    const wrongRoot = parseResolvedProjectCommandResult(
      {
        stdout: JSON.stringify({
          ok: true,
          trailId: selectedProject.trailId,
          root: 'C:\\Users\\student\\stale_workspace',
        }),
        stderr: '',
        exitCode: 0,
      },
      selectedProject,
    );
    expect(wrongRoot.ok).toBe(false);
    expect(wrongRoot.text).toContain('not the selected project');
  });

  test('stores versioned claims and rebases a report only for the same trail', () => {
    const marker = createProjectControlMarker(
      'claim_one',
      'report',
      selectedProject,
      'C:\\Users\\student\\word_sparkle\\.showtail\\reports\\report.html',
    );
    expect(marker.showtailProjectControl).toBe(SHOWTAIL_PROJECT_CONTROL_PROTOCOL);
    const claims = parseStoredProjectControlClaims(
      [{ ...marker, createdAt: '2026-09-11T12:00:00.000Z' }],
      Date.parse('2026-09-11T13:00:00.000Z'),
    );
    expect(claims).toHaveLength(1);
    expect(
      reportPathFromClaim(claims[0]!, {
        ...selectedProject,
        root: 'C:\\Users\\student\\Games\\word_sparkle',
      }),
    ).toBe('C:\\Users\\student\\Games\\word_sparkle\\.showtail\\reports\\report.html');
    expect(
      reportPathFromClaim(claims[0]!, {
        ...selectedProject,
        trailId: 'trl_different',
      }),
    ).toBeUndefined();
  });

  test('finds the newest valid report claim across intervening controls', () => {
    const reportPath =
      'C:\\Users\\student\\word_sparkle\\.showtail\\reports\\report.html';
    const report = createProjectControlMarker(
      'claim_report',
      'report',
      selectedProject,
      reportPath,
    );
    const status = createProjectControlMarker('claim_status', 'status', selectedProject);
    const malformed = {
      ...report,
      showtailProjectControl: 'showtail-project-control/v2',
    };

    expect(parseProjectControlMarker(report)).toEqual(report);
    expect(latestReportProjectControlClaimId([report, status, malformed])).toBe(
      'claim_report',
    );
    expect(latestReportProjectControlClaimId([status, malformed])).toBeUndefined();
    expect(latestProjectControlClaimId([report, status, malformed])).toBe('claim_status');
    expect(
      latestReportProjectControlClaimId([status, malformed]) ??
        latestProjectControlClaimId([status, malformed]),
    ).toBe('claim_status');
  });

  test('rejects expired claims and report paths outside their project', () => {
    const marker = createProjectControlMarker(
      'claim_old',
      'report',
      selectedProject,
      'C:\\Users\\student\\outside\\report.html',
    );
    expect(
      parseStoredProjectControlClaims(
        [{ ...marker, createdAt: '2026-09-01T12:00:00.000Z' }],
        Date.parse('2026-09-11T12:00:00.000Z'),
      ),
    ).toEqual([]);
  });

  test('rejects report claims whose missing path escapes through a junction', () => {
    const container = mkdtempSync(join(tmpdir(), 'showtail-protocol-escape-'));
    const project = join(container, 'project');
    const outside = join(container, 'outside');
    const reports = join(project, '.showtail', 'reports');
    mkdirSync(join(project, '.showtail'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, reports, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const selection = { ...selectedProject, root: project };
      const reportPath = join(reports, 'missing-report.html');
      const marker = createProjectControlMarker(
        'claim_escape',
        'report',
        selection,
        reportPath,
      );

      expect(parseProjectControlMarker(marker)).toBeNull();
      expect(
        reportPathFromClaim(
          { ...marker, createdAt: '2026-09-11T12:00:00.000Z' },
          selection,
        ),
      ).toBeUndefined();
    } finally {
      if (existsSync(reports)) unlinkSync(reports);
      rmSync(container, { recursive: true, force: true });
    }
  });

  test('rejects report claims that escape through a dangling file symlink', () => {
    const container = mkdtempSync(join(tmpdir(), 'showtail-protocol-dangling-'));
    const project = join(container, 'project');
    const outside = join(container, 'outside');
    const reports = join(project, '.showtail', 'reports');
    const reportPath = join(reports, 'missing-report.html');
    const outsideTarget = join(outside, 'missing-report.html');
    mkdirSync(reports, { recursive: true });
    mkdirSync(outside, { recursive: true });
    let linked = false;
    try {
      try {
        symlinkSync(outsideTarget, reportPath, 'file');
        linked = true;
      } catch (error) {
        if (
          process.platform === 'win32' &&
          ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          return;
        }
        throw error;
      }
      const selection = { ...selectedProject, root: project };
      const marker = createProjectControlMarker(
        'claim_dangling_escape',
        'report',
        selection,
        reportPath,
      );

      expect(parseProjectControlMarker(marker)).toBeNull();
      expect(
        reportPathFromClaim(
          { ...marker, createdAt: '2026-09-11T12:00:00.000Z' },
          selection,
        ),
      ).toBeUndefined();
    } finally {
      if (linked) unlinkSync(reportPath);
      rmSync(container, { recursive: true, force: true });
    }
  });
});

describe('chat project path parsing', () => {
  test('treats an omitted path as an implicit-workspace request', () => {
    expect(parseOptionalProjectPath('   ')).toEqual({ ok: true });
  });

  test('parses quoted and unquoted absolute Windows paths as one argument', () => {
    expect(parseOptionalProjectPath('  "C:\\Users\\student\\My Game"  ')).toEqual({
      ok: true,
      path: 'C:\\Users\\student\\My Game',
    });
    expect(parseOptionalProjectPath('C:\\Users\\student\\My Game')).toEqual({
      ok: true,
      path: 'C:\\Users\\student\\My Game',
    });
    expect(parseOptionalProjectPath("'\\\\server\\class share\\My Game'")).toEqual({
      ok: true,
      path: '\\\\server\\class share\\My Game',
    });
  });

  test('lets an explicit moved-project path override a stale open workspace', () => {
    expect(
      selectProjectPath(
        '"C:\\Users\\student\\My Game"',
        'C:\\Users\\student\\Nextcloud\\Open Workspace',
      ),
    ).toEqual({
      ok: true,
      path: 'C:\\Users\\student\\My Game',
      explicit: true,
    });
    expect(
      selectProjectPath('', 'C:\\Users\\student\\Nextcloud\\Open Workspace'),
    ).toEqual({
      ok: true,
      path: 'C:\\Users\\student\\Nextcloud\\Open Workspace',
      explicit: false,
    });
  });

  test('accepts POSIX paths and normalizes harmless path segments', () => {
    expect(parseOptionalProjectPath('"/work/course/../game"')).toEqual({
      ok: true,
      path: '/work/game',
    });
  });

  test('rejects relative, drive-relative, malformed, and multi-argument paths', () => {
    expect(parseOptionalProjectPath('game')).toMatchObject({ ok: false });
    expect(parseOptionalProjectPath('C:game')).toMatchObject({ ok: false });
    expect(parseOptionalProjectPath('"C:\\Games\\Mine')).toMatchObject({ ok: false });
    expect(parseOptionalProjectPath('"C:\\Games\\Mine" --force')).toMatchObject({
      ok: false,
    });
    expect(parseOptionalProjectPath('C:\\Games\\"Mine"')).toMatchObject({ ok: false });
    expect(parseOptionalProjectPath('C:\\Games\0Mine')).toMatchObject({ ok: false });
  });
});

describe('report result parsing', () => {
  test('requires the exact resolved trail identity for project-control reports', () => {
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: true,
            trailId: selectedProject.trailId,
            root: selectedProject.root,
            reportPath:
              'C:\\Users\\student\\word_sparkle\\.showtail\\reports\\report.html',
          }),
          stderr: '',
          exitCode: 0,
        },
        selectedProject.root,
        { exactRoot: true, expectedTrailId: selectedProject.trailId },
      ),
    ).toEqual({
      ok: true,
      trailId: selectedProject.trailId,
      root: selectedProject.root,
      path: 'C:\\Users\\student\\word_sparkle\\.showtail\\reports\\report.html',
    });

    const missingIdentity = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: selectedProject.root,
          reportPath: 'C:\\Users\\student\\word_sparkle\\.showtail\\reports\\report.html',
        }),
        stderr: '',
        exitCode: 0,
      },
      selectedProject.root,
      { expectedTrailId: selectedProject.trailId },
    );
    expect(missingIdentity).toMatchObject({ ok: false });
    expect(missingIdentity.ok ? '' : missingIdentity.message).toContain(
      'did not identify the trail',
    );
  });

  test('reads the report path from machine-readable output', () => {
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: true,
            root: '/project',
            reportPath: '/project/report.html',
          }),
          stderr: '',
          exitCode: 0,
        },
        '/project',
      ),
    ).toEqual({ ok: true, root: '/project', path: '/project/report.html' });
  });

  test('surfaces recovered moved sessions before the report path', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: '/project',
          reportPath: '/project/report.html',
          relocatedSessions: [
            {
              id: 'led_recovered_one',
              from: '/old/project',
              to: '/project',
              tier: 'A',
              detail: 'Exact content and Git history match.',
            },
            {
              id: 'led_recovered_two',
              from: '/backup/project',
              to: '/project',
              tier: 'A',
              detail: 'Exact content match.',
            },
          ],
          relocationCandidates: [],
        }),
        stderr: '',
        exitCode: 0,
      },
      '/project',
    );

    expect(result).toEqual({
      ok: true,
      root: '/project',
      path: '/project/report.html',
      relocatedSessions: [
        {
          id: 'led_recovered_one',
          from: '/old/project',
          to: '/project',
          tier: 'A',
          detail: 'Exact content and Git history match.',
        },
        {
          id: 'led_recovered_two',
          from: '/backup/project',
          to: '/project',
          tier: 'A',
          detail: 'Exact content match.',
        },
      ],
      relocationCandidates: [],
    });
    expect(reportResultMarkdown(result)).toBe(
      'Recovered 2 moved sessions from `/old/project`, `/backup/project`.\n\n' +
        'Report written to `/project/report.html`.',
    );
    expect(reportRecoveryNotice(result)).toBe(
      'Recovered 2 moved sessions from /old/project, /backup/project.',
    );
  });

  test('accepts the keyed human output emitted by the CLI', () => {
    expect(
      parseReportResult(
        {
          stdout: 'Wrote report (team): /project/report-team.html\n',
          stderr: '',
          exitCode: 0,
        },
        '/project',
      ),
    ).toEqual({
      ok: true,
      root: '/project',
      path: '/project/report-team.html',
    });
  });

  test('accepts a canonical project root that contains the selected subfolder', () => {
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: true,
            root: '/project',
            reportPath: '/project/.showtail/reports/report.html',
          }),
          stderr: '',
          exitCode: 0,
        },
        '/project/src/game',
      ),
    ).toEqual({
      ok: true,
      root: '/project',
      path: '/project/.showtail/reports/report.html',
    });
  });

  test('requires an explicit slash-command folder to be the canonical root', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: '/project',
          reportPath: '/project/.showtail/reports/report.html',
        }),
        stderr: '',
        exitCode: 0,
      },
      '/project/src/game',
      { exactRoot: true },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('Pass the actual project root');
  });

  test('rejects HOME as an implicit catch-all ancestor', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: 'C:\\Users\\student',
          reportPath: 'C:\\Users\\student\\.showtail\\reports\\home-report.html',
        }),
        stderr: '',
        exitCode: 0,
      },
      'C:\\Users\\student\\My Game',
      { disallowedAncestorRoots: ['C:\\Users\\student'] },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('broad home folder');
  });

  test('validates Windows report paths without case-sensitive false mismatches', () => {
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: true,
            root: 'c:\\users\\student\\my game',
            reportPath: 'C:\\USERS\\STUDENT\\MY GAME\\.showtail\\reports\\report.html',
          }),
          stderr: '',
          exitCode: 0,
        },
        'C:\\Users\\Student\\My Game',
      ),
    ).toEqual({
      ok: true,
      root: 'c:\\users\\student\\my game',
      path: 'C:\\USERS\\STUDENT\\MY GAME\\.showtail\\reports\\report.html',
    });
  });

  test('refuses a successful response for a stale workspace root', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: '/open/nextcloud-workspace',
          reportPath: '/open/nextcloud-workspace/.showtail/reports/report.html',
        }),
        stderr: '',
        exitCode: 0,
      },
      '/moved/game',
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('not the selected project');
  });

  test('refuses a report path outside the returned canonical root', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: '/project',
          reportPath: '/other/.showtail/reports/report.html',
        }),
        stderr: '',
        exitCode: 0,
      },
      '/project',
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('outside the selected project');
  });

  test('refuses a missing report path whose nearest existing parent escapes', () => {
    const container = mkdtempSync(join(tmpdir(), 'showtail-report-escape-'));
    const project = join(container, 'project');
    const outside = join(container, 'outside');
    const reports = join(project, '.showtail', 'reports');
    mkdirSync(join(project, '.showtail'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, reports, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = parseReportResult(
        {
          stdout: JSON.stringify({
            ok: true,
            root: project,
            reportPath: join(reports, 'missing-report.html'),
          }),
          stderr: '',
          exitCode: 0,
        },
        project,
        { exactRoot: true },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? '' : result.message).toContain('outside the selected project');
    } finally {
      if (existsSync(reports)) unlinkSync(reports);
      rmSync(container, { recursive: true, force: true });
    }
  });

  test('refuses a report path that escapes through a dangling file symlink', () => {
    const container = mkdtempSync(join(tmpdir(), 'showtail-report-dangling-'));
    const project = join(container, 'project');
    const outside = join(container, 'outside');
    const reports = join(project, '.showtail', 'reports');
    const reportPath = join(reports, 'missing-report.html');
    const outsideTarget = join(outside, 'missing-report.html');
    mkdirSync(reports, { recursive: true });
    mkdirSync(outside, { recursive: true });
    let linked = false;
    try {
      try {
        symlinkSync(outsideTarget, reportPath, 'file');
        linked = true;
      } catch (error) {
        if (
          process.platform === 'win32' &&
          ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          return;
        }
        throw error;
      }
      const result = parseReportResult(
        {
          stdout: JSON.stringify({ ok: true, root: project, reportPath }),
          stderr: '',
          exitCode: 0,
        },
        project,
        { exactRoot: true },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? '' : result.message).toContain('outside the selected project');
    } finally {
      if (linked) unlinkSync(reportPath);
      rmSync(container, { recursive: true, force: true });
    }
  });

  test('accepts an existing project alias when the report stays in the real root', () => {
    const container = mkdtempSync(join(tmpdir(), 'showtail-report-alias-'));
    const project = join(container, 'project');
    const alias = join(container, 'project-alias');
    const reports = join(project, '.showtail', 'reports');
    mkdirSync(reports, { recursive: true });
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(
        parseReportResult(
          {
            stdout: JSON.stringify({
              ok: true,
              root: project,
              reportPath: join(reports, 'missing-report.html'),
            }),
            stderr: '',
            exitCode: 0,
          },
          alias,
          { exactRoot: true },
        ),
      ).toEqual({
        ok: true,
        root: project,
        path: join(reports, 'missing-report.html'),
      });
    } finally {
      if (existsSync(alias)) unlinkSync(alias);
      rmSync(container, { recursive: true, force: true });
    }
  });

  test('keeps pending ranges on a successful report and warns without failing it', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: true,
          root: '/project',
          reportPath: '/project/.showtail/reports/report.html',
          pendingRanges: [pendingRangeFixture],
        }),
        stderr: '',
        exitCode: 0,
      },
      '/project',
    );

    expect(result).toMatchObject({
      ok: true,
      pendingRanges: [
        {
          id: 'copilot-session/range-2',
          firstPrompt: null,
          reason: 'multiple project candidates',
          candidates: ['/course/game', '/course/old-game'],
        },
      ],
    });
    expect(reportResultMarkdown(result)).toContain('Report written to');
    expect(reportResultMarkdown(result)).toContain('`copilot-session/range-2`');
    expect(reportResultMarkdown(result)).toContain('`showtail inbox`');
  });

  test('surfaces exit 4 guidance instead of suggesting obsolete track setup', () => {
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: false,
            code: 4,
            errorCode: 'NO_MATCHING_WORK',
            message: 'No captured work matches this project yet. Keep working here.',
          }),
          stderr: '',
          exitCode: 4,
        },
        '/project',
      ),
    ).toEqual({
      ok: false,
      message: 'No captured work matches this project yet. Keep working here.',
    });
  });

  test('surfaces exit 2 ambiguity guidance and candidates', () => {
    const message =
      'No single project could be selected.\nCandidate project roots:\n  /one\n  /two';
    expect(
      parseReportResult(
        {
          stdout: JSON.stringify({
            ok: false,
            code: 2,
            errorCode: 'AMBIGUOUS_PROJECT',
            message,
          }),
          stderr: '',
          exitCode: 2,
        },
        '/project',
      ),
    ).toEqual({ ok: false, message });
  });

  test('surfaces structured moved-work candidates that require review', () => {
    const message = 'Showtail found moved work that needs your review.';
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: false,
          code: 2,
          errorCode: 'RELOCATION_REVIEW_REQUIRED',
          message,
          nextAction: 'review-relocation',
          relocatedSessions: [],
          relocationCandidates: [
            {
              id: 'led_review_me',
              from: '/old/project',
              to: '/project',
              tier: 'B',
              detail: 'Files are similar, but there is no exact content match.',
              reason: 'similarity',
            },
          ],
        }),
        stderr: '',
        exitCode: 2,
      },
      '/project',
    );

    expect(result).toEqual({
      ok: false,
      message,
      errorCode: 'RELOCATION_REVIEW_REQUIRED',
      nextAction: 'review-relocation',
      relocatedSessions: [],
      relocationCandidates: [
        {
          id: 'led_review_me',
          from: '/old/project',
          to: '/project',
          tier: 'B',
          detail: 'Files are similar, but there is no exact content match.',
          reason: 'similarity',
        },
      ],
    });
    expect(reportResultMarkdown(result)).toBe(
      'Showtail found moved work that needs your review.\n\n' +
        '1 moved session needs review:\n' +
        '- `led_review_me`: similar content only from `/old/project` to `/project` - ' +
        'Files are similar, but there is no exact content match.',
    );
    expect(reportRecoveryNotice(result)).toBeUndefined();
  });

  test('keeps nested pending ranges on report errors', () => {
    const result = parseReportResult(
      {
        stdout: JSON.stringify({
          ok: false,
          message: 'No single project could be selected.',
          details: { pendingRanges: [pendingRangeFixture] },
        }),
        stderr: '',
        exitCode: 2,
      },
      '/project',
    );

    expect(result).toMatchObject({
      ok: false,
      pendingRanges: [{ id: 'copilot-session/range-2' }],
    });
    expect(reportResultMarkdown(result)).toContain(
      'No single project could be selected.',
    );
    expect(reportResultMarkdown(result)).toContain('Run `showtail inbox`');
  });
});

describe('status and verify result parsing', () => {
  test('preserves typed pending ranges while keeping status output concise', () => {
    const payload = {
      initialized: true,
      root: '/project',
      pendingRanges: [pendingRangeFixture],
      futureField: 'kept',
    };
    const result = parseProjectCommandResult({
      stdout: JSON.stringify(payload),
      stderr: '',
      exitCode: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.payload).toEqual(payload);
    expect(result.pendingRanges).toEqual([
      {
        id: 'copilot-session/range-2',
        sessionId: 'copilot-session',
        rangeId: 'range-2',
        startedAt: '2026-09-10T12:00:00.000Z',
        lastSeenAt: '2026-09-10T12:04:00.000Z',
        firstPrompt: null,
        lastPrompt: 'Move the game.',
        prompts: 2,
        edits: 3,
        reason: 'multiple project candidates',
        candidates: ['/course/game', '/course/old-game'],
      },
    ]);
    expect(result.text).not.toContain('pendingRanges');
    expect(result.text).toContain('futureField');
    expect(projectCommandResultMarkdown(result)).toContain('```json');
    expect(projectCommandResultMarkdown(result)).toContain('`showtail inbox`');
  });

  test('propagates pending ranges from structured command errors', () => {
    const result = parseProjectCommandResult({
      stdout: JSON.stringify({
        ok: false,
        message: 'No single project could be selected.',
        pendingRanges: [
          {
            id: 'session/range',
            reason: 'ambiguous',
            candidates: ['/one', 42, '/two'],
            extra: 'ignored',
          },
        ],
      }),
      stderr: '',
      exitCode: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      text: 'No single project could be selected.',
      pendingRanges: [
        {
          id: 'session/range',
          reason: 'ambiguous',
          candidates: ['/one', '/two'],
        },
      ],
    });
    expect(projectCommandResultMarkdown(result)).toContain('`session/range`');
  });

  test('formats concise pending-range markdown and notices', () => {
    const ranges = [
      {
        id: 'session/range',
        reason: 'no project evidence',
        candidates: [],
      },
    ];
    expect(pendingRangesMarkdown(ranges)).toContain('no unique project candidate');
    expect(pendingRangesNotice(ranges)).toBe(
      '1 captured work range still needs placement. Run showtail inbox.',
    );
  });
});
