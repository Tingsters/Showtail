import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const openTextDocument = mock(async (path: string) => ({ path }));
const showTextDocument = mock(async () => undefined);
const showQuickPick = mock(async () => undefined as unknown);
const workspaceFolders: Array<{ uri: { fsPath: string } }> = [];

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders,
    openTextDocument,
  },
  window: {
    showTextDocument,
    showQuickPick,
  },
  lm: {},
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(readonly value: string) {}
  },
  LanguageModelToolResult: class LanguageModelToolResult {
    constructor(readonly content: unknown[]) {}
  },
}));

const { ProjectControlController, projectControlToolResult } =
  await import('../src/projectControl');

const CLAIMS_KEY = 'showtail.projectControl.claims.v1';
const root = resolve(import.meta.dir, '..');
const reportPath = join(import.meta.dir, 'showtailProtocol.test.ts');
const selection = {
  trailId: 'trl_extension_test',
  root,
  displayName: 'Extension Test',
  mode: 'authoritative' as const,
  evidence: ['explicit-trail-id', 'live-config'],
};

function state(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

function claimFor(selected: typeof selection, path: string) {
  return {
    showtailProjectControl: 'showtail-project-control/v1',
    claimId: 'claim_previous',
    action: 'report',
    ...selected,
    reportPath: path,
    createdAt: new Date().toISOString(),
  };
}

function claim(path: string) {
  return claimFor(selection, path);
}

function selectedResult(selected = selection) {
  return {
    stdout: JSON.stringify({
      schemaVersion: 1,
      state: 'selected',
      selection: selected,
    }),
    stderr: '',
    exitCode: 0,
  };
}

beforeEach(() => {
  workspaceFolders.length = 0;
  openTextDocument.mockClear();
  showTextDocument.mockClear();
  showQuickPick.mockClear();
  showQuickPick.mockImplementation(async () => undefined);
});

function controller(
  run: (
    args: string[],
    cwd: string,
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>,
  claims: unknown[],
  workspaceState = state(),
) {
  const globalState = state({ [CLAIMS_KEY]: claims });
  const context = {
    globalState,
    workspaceState,
  };
  const output = { appendLine: mock(() => undefined) };
  return {
    globalState,
    workspaceState,
    projectControl: new ProjectControlController(
      context as never,
      run,
      output as never,
      () => 'github-copilot',
    ),
  };
}

describe('project-control report claims', () => {
  test('reuses the newest valid report after resolving open_report without a claim id', async () => {
    const calls: string[][] = [];
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        expect(args[0]).toBe('projects');
        return selectedResult();
      },
      [claim(reportPath)],
    );

    const result = await projectControl.execute({ action: 'open_report' });

    expect(result).toMatchObject({ ok: true, opened: true, reportPath });
    expect(calls.map((args) => args[0])).toEqual(['projects']);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
    expect(openTextDocument).toHaveBeenCalledWith(reportPath);
  });

  test('generates once when an automatically matched stored report is missing', async () => {
    const calls: string[][] = [];
    const missing = join(root, 'missing-automatic-report.html');
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') return selectedResult();
        if (args[0] === 'report') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              reportPath,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [claim(missing)],
    );

    const result = await projectControl.execute({ action: 'open_report' });

    expect(result).toMatchObject({ ok: true, opened: true, reportPath });
    expect(calls.filter((args) => args[0] === 'projects')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(1);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  test('coalesces concurrent open_report calls without a prior claim', async () => {
    const calls: string[][] = [];
    let releaseReport: (() => void) | undefined;
    const reportGate = new Promise<void>((resolveGate) => {
      releaseReport = resolveGate;
    });
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (args[0] === 'projects') return selectedResult();
      if (args[0] === 'report') {
        await reportGate;
        return {
          stdout: JSON.stringify({
            ok: true,
            trailId: selection.trailId,
            root,
            reportPath,
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }, []);

    const first = projectControl.execute({ action: 'open_report' });
    const second = projectControl.execute({ action: 'open_report' });
    releaseReport?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    expect(calls.filter((args) => args[0] === 'projects')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(1);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  test('opens a valid prior report without invoking report again', async () => {
    const calls: string[][] = [];
    const { globalState, projectControl } = controller(
      async (args) => {
        calls.push(args);
        expect(args[0]).toBe('projects');
        return selectedResult();
      },
      [claim(reportPath)],
    );

    const result = await projectControl.execute({
      action: 'open_report',
      priorClaimId: 'claim_previous',
    });

    expect(result).toMatchObject({ ok: true, opened: true, reportPath });
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(0);
    expect(openTextDocument).toHaveBeenLastCalledWith(reportPath);
    const stored = globalState.get<Array<{ claimId: string }>>(CLAIMS_KEY) ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.claimId).not.toBe('claim_previous');
  });

  test('replays a completed prior-claim execution without opening twice', async () => {
    const calls: string[][] = [];
    const requestIdentity = {};
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        return selectedResult();
      },
      [claim(reportPath)],
    );

    const input = { action: 'open_report' as const, priorClaimId: 'claim_previous' };
    const first = await projectControl.execute(input, undefined, { requestIdentity });
    const replay = await projectControl.execute(input, undefined, { requestIdentity });

    expect(replay).toEqual(first);
    expect(calls.map((args) => args[0])).toEqual(['projects', 'projects']);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  test('does not replay a completed claim into a later native request', async () => {
    const calls: string[][] = [];
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        return selectedResult();
      },
      [claim(reportPath)],
    );
    const input = { action: 'open_report' as const, priorClaimId: 'claim_previous' };

    const first = await projectControl.execute(input, undefined, {
      requestIdentity: {},
    });
    const later = await projectControl.execute(input, undefined, {
      requestIdentity: {},
    });

    expect(first).toMatchObject({ ok: true, opened: true, reportPath });
    expect(later).toMatchObject({ ok: true, opened: true, reportPath });
    expect(later.ok && first.ok ? later.marker.claimId : '').not.toBe(
      first.ok ? first.marker.claimId : '',
    );
    expect(calls.map((args) => args[0])).toEqual(['projects', 'projects']);
    expect(openTextDocument).toHaveBeenCalledTimes(2);
  });

  test('regenerates a deleted report instead of replaying stale opened success', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'showtail-vscode-report-cache-'));
    const originalReport = join(projectRoot, 'original-report.html');
    const regeneratedReport = join(projectRoot, 'regenerated-report.html');
    writeFileSync(originalReport, 'original');
    writeFileSync(regeneratedReport, 'regenerated');
    const selected = { ...selection, root: projectRoot };
    const requestIdentity = {};
    const calls: string[][] = [];
    try {
      const { projectControl } = controller(
        async (args) => {
          calls.push(args);
          if (args[0] === 'projects') return selectedResult(selected);
          if (args[0] === 'report') {
            return {
              stdout: JSON.stringify({
                ok: true,
                trailId: selected.trailId,
                root: projectRoot,
                reportPath: regeneratedReport,
              }),
              stderr: '',
              exitCode: 0,
            };
          }
          throw new Error(`Unexpected command: ${args.join(' ')}`);
        },
        [claimFor(selected, originalReport)],
      );
      const input = { action: 'open_report' as const, priorClaimId: 'claim_previous' };

      const first = await projectControl.execute(input, undefined, { requestIdentity });
      unlinkSync(originalReport);
      const refreshed = await projectControl.execute(input, undefined, {
        requestIdentity,
      });

      expect(first).toMatchObject({ ok: true, reportPath: originalReport, opened: true });
      expect(refreshed).toMatchObject({
        ok: true,
        reportPath: regeneratedReport,
        opened: true,
      });
      expect(refreshed.ok && first.ok ? refreshed.marker.claimId : '').not.toBe(
        first.ok ? first.marker.claimId : '',
      );
      expect(calls.map((args) => args[0])).toEqual(['projects', 'projects', 'report']);
      expect(openTextDocument.mock.calls.map(([path]) => path)).toEqual([
        originalReport,
        regeneratedReport,
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('refreshes a completed claim when its trail moves to a new root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'showtail-vscode-project-cache-'));
    const originalRoot = join(parent, 'original');
    const movedRoot = join(parent, 'moved');
    mkdirSync(originalRoot);
    mkdirSync(movedRoot);
    const originalReport = join(originalRoot, 'report.html');
    const movedReport = join(movedRoot, 'report.html');
    writeFileSync(originalReport, 'original');
    writeFileSync(movedReport, 'moved');
    const originalSelection = { ...selection, root: originalRoot };
    const movedSelection = { ...selection, root: movedRoot };
    const requestIdentity = {};
    const calls: Array<{ args: string[]; cwd: string }> = [];
    let currentSelection = originalSelection;
    try {
      const { projectControl } = controller(
        async (args, cwd) => {
          calls.push({ args, cwd });
          if (args[0] === 'projects') return selectedResult(currentSelection);
          if (args[0] === 'report') {
            return {
              stdout: JSON.stringify({
                ok: true,
                trailId: movedSelection.trailId,
                root: movedRoot,
                reportPath: movedReport,
              }),
              stderr: '',
              exitCode: 0,
            };
          }
          throw new Error(`Unexpected command: ${args.join(' ')}`);
        },
        [claimFor(originalSelection, originalReport)],
      );
      const input = { action: 'open_report' as const, priorClaimId: 'claim_previous' };

      const first = await projectControl.execute(input, undefined, { requestIdentity });
      currentSelection = movedSelection;
      const refreshed = await projectControl.execute(input, undefined, {
        requestIdentity,
      });

      expect(first).toMatchObject({ ok: true, selection: originalSelection });
      expect(refreshed).toMatchObject({
        ok: true,
        selection: movedSelection,
        reportPath: movedReport,
      });
      expect(calls.map(({ args }) => args[0])).toEqual([
        'projects',
        'projects',
        'report',
      ]);
      expect(calls.find(({ args }) => args[0] === 'report')?.cwd).toBe(movedRoot);
      expect(openTextDocument.mock.calls.map(([path]) => path)).toEqual([
        originalReport,
        movedReport,
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('regenerates a missing claimed report exactly once', async () => {
    const calls: string[][] = [];
    const missing = join(root, 'missing-report.html');
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') return selectedResult();
        if (args[0] === 'report') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              reportPath,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [claim(missing)],
    );

    const result = await projectControl.execute({
      action: 'open_report',
      priorClaimId: 'claim_previous',
    });

    expect(result).toMatchObject({ ok: true, opened: true, reportPath });
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(1);
  });

  test('coalesces concurrent reuse of one missing-report claim', async () => {
    openTextDocument.mockClear();
    const calls: string[][] = [];
    const missing = join(root, 'missing-concurrent-report.html');
    let releaseReport: (() => void) | undefined;
    const reportGate = new Promise<void>((resolveGate) => {
      releaseReport = resolveGate;
    });
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') return selectedResult();
        if (args[0] === 'report') {
          await reportGate;
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              reportPath,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [claim(missing)],
    );

    const first = projectControl.execute({
      action: 'open_report',
      priorClaimId: 'claim_previous',
    });
    const second = projectControl.execute({
      action: 'open_report',
      priorClaimId: 'claim_previous',
    });
    releaseReport?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ ok: true, opened: true, reportPath });
    expect(secondResult).toEqual(firstResult);
    expect(calls.filter((args) => args[0] === 'projects')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(1);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  test('lets an explicit selector override a prior report claim', async () => {
    openTextDocument.mockClear();
    const calls: string[][] = [];
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') {
          expect(args[1]).toBe('new game');
          return selectedResult();
        }
        if (args[0] === 'report') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              reportPath,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [claim(reportPath)],
    );

    const result = await projectControl.execute({
      action: 'open_report',
      selector: 'new game',
      priorClaimId: 'claim_previous',
    });

    expect(result).toMatchObject({ ok: true, opened: true, reportPath });
    expect(calls.filter((args) => args[0] === 'projects')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'report')).toHaveLength(1);
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  test('inherits a prior claim for a generic verify followup', async () => {
    const calls: string[][] = [];
    const { globalState, projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') return selectedResult();
        if (args[0] === 'verify') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              checks: [],
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [claim(reportPath)],
    );

    const result = await projectControl.execute({
      action: 'verify',
      priorClaimId: 'claim_previous',
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'verify',
      selection,
    });
    expect(calls.map((args) => args[0])).toEqual(['projects', 'verify']);
    const stored = globalState.get<Array<{ claimId: string }>>(CLAIMS_KEY) ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.claimId).not.toBe('claim_previous');
  });

  test('pins a duplicate trail selection to its explicit path for report and status', async () => {
    const calls: string[][] = [];
    const duplicateSelection = {
      ...selection,
      evidence: ['duplicate-trail-explicit-path', 'live-config'],
    };
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (args[0] === 'projects') return selectedResult(duplicateSelection);
      if (args[0] === 'report') {
        return {
          stdout: JSON.stringify({
            ok: true,
            trailId: duplicateSelection.trailId,
            root: duplicateSelection.root,
            reportPath,
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            ok: true,
            trailId: duplicateSelection.trailId,
            root: duplicateSelection.root,
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }, []);

    const report = await projectControl.execute({
      action: 'report',
      selector: duplicateSelection.root,
    });
    const status = await projectControl.execute({
      action: 'status',
      selector: duplicateSelection.root,
    });

    expect(report).toMatchObject({ ok: true, selection: duplicateSelection });
    expect(status).toMatchObject({ ok: true, selection: duplicateSelection });
    expect(calls.filter((args) => args[0] === 'report')[0]?.[2]).toBe(
      duplicateSelection.root,
    );
    expect(calls.filter((args) => args[0] === 'status')[0]?.[2]).toBe(
      duplicateSelection.root,
    );
  });

  test('keeps an explicit duplicate-path claim pinned to the same physical root', async () => {
    const calls: string[][] = [];
    const duplicateClaim = {
      ...claim(reportPath),
      evidence: ['duplicate-trail-explicit-path', 'live-config'],
    };
    const duplicateSelection = {
      ...selection,
      evidence: duplicateClaim.evidence,
    };
    const { projectControl } = controller(
      async (args) => {
        calls.push(args);
        if (args[0] === 'projects') {
          expect(args[1]).toBe(root);
          return selectedResult(duplicateSelection);
        }
        if (args[0] === 'verify') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
              checks: [],
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      [duplicateClaim],
    );

    const result = await projectControl.execute({
      action: 'verify',
      priorClaimId: 'claim_previous',
    });

    expect(result).toMatchObject({ ok: true, selection: duplicateSelection });
    expect(calls.filter((args) => args[0] === 'verify')[0]?.[2]).toBe(root);
  });

  test('surfaces compact pending-range counts from a successful report', async () => {
    const { projectControl } = controller(async (args) => {
      if (args[0] === 'projects') return selectedResult();
      if (args[0] === 'report') {
        return {
          stdout: JSON.stringify({
            ok: true,
            trailId: selection.trailId,
            root,
            reportPath,
            routing: { pendingRanges: 37 },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }, []);

    const result = await projectControl.execute({
      action: 'report',
      selector: selection.trailId,
    });

    expect(result.ok ? result.text : '').toContain(
      '37 captured work ranges still need placement',
    );
  });

  test('treats a workspace junction as the same physical project root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'showtail-vscode-alias-'));
    const alias = join(parent, 'project-alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    workspaceFolders.push({ uri: { fsPath: alias } });
    try {
      const { projectControl } = controller(async (args) => {
        if (args[0] === 'projects') return selectedResult();
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              ok: true,
              trailId: selection.trailId,
              root,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      }, []);

      const result = await projectControl.execute({
        action: 'status',
        selector: selection.trailId,
      });

      expect(result).toMatchObject({ ok: true });
      expect(result.ok ? result.selection.crossWorkspace : true).toBeUndefined();
    } finally {
      workspaceFolders.length = 0;
      unlinkSync(alias);
      rmdirSync(parent);
    }
  });

  test('requires a local pick for a semantic path and revalidates it before running', async () => {
    const calls: string[][] = [];
    showQuickPick.mockImplementationOnce(
      async (items: unknown) => (items as unknown[])[0],
    );
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (args[0] === 'projects') return selectedResult();
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({ ok: true, trailId: selection.trailId, root }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }, []);

    const result = await projectControl.execute(
      { action: 'status', selector: root },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(calls.map((args) => args[0])).toEqual(['projects', 'projects', 'status']);
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });

  test('a cancelled semantic-path picker runs no project command', async () => {
    const calls: string[][] = [];
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      return selectedResult();
    }, []);

    const result = await projectControl.execute(
      { action: 'verify', selector: root },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(calls.map((args) => args[0])).toEqual(['projects']);
  });

  test('a semantic-path pick fails closed when exact revalidation changes', async () => {
    const calls: string[][] = [];
    showQuickPick.mockImplementationOnce(
      async (items: unknown) => (items as unknown[])[0],
    );
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (calls.length === 1) return selectedResult();
      return {
        stdout: JSON.stringify({ schemaVersion: 1, state: 'not-found' }),
        stderr: '',
        exitCode: 0,
      };
    }, []);

    const result = await projectControl.execute(
      { action: 'verify', selector: root },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('changed');
    expect(calls.map((args) => args[0])).toEqual(['projects', 'projects']);
  });

  test('a current captured edit corroborates one complete semantic project name', async () => {
    workspaceFolders.push({ uri: { fsPath: root } });
    const focused = { ...selection, displayName: 'Word Sparkle' };
    const calls: string[][] = [];
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (calls.length === 1 || calls.length === 3) return selectedResult(focused);
      if (calls.length === 2) {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            state: 'confirmation-required',
            selector: 'sparkle word game',
            candidates: [focused],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({ ok: true, trailId: focused.trailId, root }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }, []);

    await projectControl.noteEditProject(join(root, 'src', 'game.ts'));
    const result = await projectControl.execute(
      { action: 'status', selector: 'sparkle word game' },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({
      ok: true,
      selection: {
        trailId: focused.trailId,
        mode: 'corroborated',
        evidence: ['complete-name', 'trusted-edit-focus', 'live-config'],
      },
    });
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  test('a current edit focus cannot authorize a generic one-word project name', async () => {
    workspaceFolders.push({ uri: { fsPath: root } });
    const focused = { ...selection, displayName: 'Sparkle' };
    const calls: string[][] = [];
    const { projectControl } = controller(async (args) => {
      calls.push(args);
      if (calls.length === 1) return selectedResult(focused);
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'confirmation-required',
          selector: 'sparkle',
          candidates: [focused],
        }),
        stderr: '',
        exitCode: 0,
      };
    }, []);
    await projectControl.noteEditProject(join(root, 'game.ts'));

    const result = await projectControl.execute(
      { action: 'status', selector: 'sparkle' },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(calls.map((args) => args[0])).toEqual(['projects', 'projects']);
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });

  test('edit focus from an earlier activation cannot authorize a semantic name', async () => {
    workspaceFolders.push({ uri: { fsPath: root } });
    const focused = { ...selection, displayName: 'Word Sparkle' };
    const sharedWorkspaceState = state();
    const first = controller(
      async () => selectedResult(focused),
      [],
      sharedWorkspaceState,
    ).projectControl;
    await first.noteEditProject(join(root, 'game.ts'));

    const calls: string[][] = [];
    const second = controller(
      async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            state: 'confirmation-required',
            selector: 'sparkle word game',
            candidates: [focused],
          }),
          stderr: '',
          exitCode: 0,
        };
      },
      [],
      sharedWorkspaceState,
    ).projectControl;

    const result = await second.execute(
      { action: 'status', selector: 'sparkle word game' },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(calls.map((args) => args[0])).toEqual(['projects']);
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });

  test('persisted focus from another workspace context does not rank its project first', async () => {
    const otherRoot = join(root, 'other-workspace');
    const focused = { ...selection, displayName: 'Zed Project' };
    const other = {
      ...selection,
      trailId: 'trl_alpha',
      root: otherRoot,
      displayName: 'Alpha Project',
    };
    const sharedWorkspaceState = state();
    workspaceFolders.push({ uri: { fsPath: root } });
    const first = controller(
      async () => selectedResult(focused),
      [],
      sharedWorkspaceState,
    ).projectControl;
    await first.noteEditProject(join(root, 'game.ts'));

    workspaceFolders.splice(0, workspaceFolders.length, {
      uri: { fsPath: otherRoot },
    });
    let labels: string[] = [];
    showQuickPick.mockImplementationOnce(async (items: unknown) => {
      labels = (items as Array<{ label: string }>).map((item) => item.label);
      return undefined;
    });
    const second = controller(
      async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'ambiguous',
          candidates: [focused, other],
        }),
        stderr: '',
        exitCode: 0,
      }),
      [],
      sharedWorkspaceState,
    ).projectControl;

    const result = await second.execute(
      { action: 'status', selector: 'project' },
      undefined,
      { selectorSource: 'semantic' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(labels).toEqual(['Alpha Project', 'Zed Project']);
  });
});

describe('project-control tool output bounds', () => {
  test('keeps large candidate failures valid JSON and below 8 KB', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      ...selection,
      trailId: `trl_candidate_${index}`,
      root: join(root, 'candidate', `${index}-${'x'.repeat(600)}`),
      displayName: `Candidate ${index} ${'y'.repeat(300)}`,
    }));
    const result = projectControlToolResult({
      ok: false,
      action: 'report',
      message: `Choose one project. ${'detail '.repeat(2_000)}`,
      resolution: {
        schemaVersion: 1,
        state: 'ambiguous',
        candidates,
        errorCode: 'PROJECT_SELECTION_REQUIRED',
      },
    });
    const value = (result.content[0] as { value: string }).value;
    const payload = JSON.parse(value) as {
      candidateCount: number;
      candidates: unknown[];
      candidatesTruncated: boolean;
    };

    expect(Buffer.byteLength(value, 'utf8')).toBeLessThan(8_000);
    expect(payload.candidateCount).toBe(100);
    expect(payload.candidates.length).toBeLessThan(100);
    expect(payload.candidatesTruncated).toBe(true);
  });

  test('keeps control-heavy failure messages valid and below 8 KB', () => {
    const result = projectControlToolResult({
      ok: false,
      action: 'verify',
      message: '\u0001'.repeat(20_000),
    });
    const value = (result.content[0] as { value: string }).value;
    const payload = JSON.parse(value) as { ok: boolean; message: string };

    expect(Buffer.byteLength(value, 'utf8')).toBeLessThan(8_000);
    expect(payload.ok).toBe(false);
    expect(payload.message.length).toBeGreaterThan(0);
  });
});
