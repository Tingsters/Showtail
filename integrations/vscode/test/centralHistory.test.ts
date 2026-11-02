import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseProjectResolution,
  parseReportResult,
  createProjectControlMarker,
  parseStoredProjectControlClaims,
  reportPathFromClaim,
} from '../src/showtailProtocol';

test('central protocol resolves project views and retains reports after project moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'showtail-vscode-central-'));
  try {
    const home = join(dir, 'data');
    const root = join(dir, 'project');
    const path = join(home, 'reports', 'snapshot', 'report.html');
    mkdirSync(join(home, 'reports', 'snapshot'), { recursive: true });
    mkdirSync(root);
    writeFileSync(path, '<html>Captured work</html>');
    const view = {
      projectId: 'prj_test',
      projectRoot: root,
      displayName: 'My project',
      roots: [root],
    };
    const result = (payload: object, exitCode = 0) => ({
      stdout: JSON.stringify({ schemaVersion: 2, home, ...payload }),
      stderr: '',
      exitCode,
    });
    const selected = parseProjectResolution(
      result({ state: 'selected', selection: view }),
    ).selection!;
    expect(selected).toMatchObject({ trailId: 'prj_test', root, home });
    expect(
      parseProjectResolution(
        result(
          {
            errorCode: 'AMBIGUOUS_PROJECT',
            candidates: [view, { ...view, projectId: 'prj_other' }],
          },
          1,
        ),
      ),
    ).toMatchObject({
      state: 'ambiguous',
      candidates: [{ trailId: 'prj_test' }, { trailId: 'prj_other' }],
    });
    expect(
      parseReportResult(result({ ...view, reportPath: path }), root, {
        expectedTrailId: 'prj_test',
      }),
    ).toMatchObject({ ok: true, path, home });
    expect(
      parseReportResult(
        result({ ...view, projectId: 'prj_wrong', reportPath: path }),
        root,
        { expectedTrailId: 'prj_test' },
      ).ok,
    ).toBe(false);
    expect(
      parseReportResult(result({ ...view, reportPath: join(root, 'report.html') }), root)
        .ok,
    ).toBe(false);
    const marker = createProjectControlMarker('central-claim', 'report', selected, path);
    const [claim] = parseStoredProjectControlClaims([
      { ...marker, createdAt: new Date().toISOString() },
    ]);
    expect(claim).toBeDefined();
    expect(reportPathFromClaim(claim!, { ...selected, root: join(dir, 'moved') })).toBe(
      path,
    );
    expect(
      reportPathFromClaim(claim!, { ...selected, home: join(dir, 'other-home') }),
    ).toBeUndefined();
    const escaped = join(home, 'reports', 'escape');
    symlinkSync(root, escaped, process.platform === 'win32' ? 'junction' : 'dir');
    expect(
      parseReportResult(
        result({ ...view, reportPath: join(escaped, 'report.html') }),
        root,
      ).ok,
    ).toBe(false);
  } finally {
    if (
      !resolve(dir).startsWith(resolve(tmpdir())) ||
      !dir.includes('showtail-vscode-central-')
    )
      throw new Error('Invalid test cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
