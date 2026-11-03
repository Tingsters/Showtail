import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { HistoryStore } from '../src/core/history.ts';
import { captureTranscript } from '../src/core/historyCapture.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { syncHistory } from '../src/core/historySync.ts';
import { fixture } from './centralHelpers.ts';
import { shellWritePaths } from '../packages/agent-traces/src/hooks/shellWrites.ts';

function trace(project: string, command: string, files = ['other-agent.ts']) {
  return (
    [
      {
        type: 'user',
        uuid: 'prompt',
        sessionId: 'workspace',
        cwd: project,
        timestamp: '2026-01-02T12:00:00.000Z',
        message: { content: 'Inspect the project.' },
      },
      {
        type: 'assistant',
        uuid: 'call',
        sessionId: 'workspace',
        cwd: project,
        timestamp: '2026-01-02T12:00:01.000Z',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', id: 'shell', input: { command } }],
        },
      },
      {
        type: 'user',
        uuid: 'result',
        sessionId: 'workspace',
        cwd: project,
        timestamp: '2026-01-02T12:00:02.000Z',
        toolUseResult: {
          stdout: '',
          stderr: '',
          interrupted: false,
          bashEditDiff: {
            files: files.map((file) => ({
              filePath: join(project, file),
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  lines: ['+export const value = true;'],
                },
              ],
              created: true,
            })),
            moreFiles: 0,
          },
        },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'shell', content: '', is_error: false },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

test('a native workspace delta during a read-only shell call is not an AI edit', () => {
  const parsed = parseClaudeTranscript(
    trace('/project', 'cat package.json; ls -la; git status --short'),
    '/project',
  );
  expect(parsed.messages.filter((message) => message.role === 'edit')).toHaveLength(0);
  expect(parsed.fileObservationCandidates).toMatchObject([
    {
      basis: 'workspace-delta',
      files: ['other-agent.ts'],
      diff: expect.stringContaining('+export const value = true;'),
    },
  ]);
});

test('literal shell write paths separate attributable native edits from concurrent deltas', () => {
  const parsed = parseClaudeTranscript(
    trace('/project', 'printf new > own.ts', ['own.ts', 'other-agent.ts']),
    '/project',
  );
  expect(
    parsed.messages
      .filter((message) => message.role === 'edit')
      .flatMap((message) => message.files ?? []),
  ).toEqual(['own.ts']);
  expect(parsed.fileObservationCandidates).toMatchObject([
    { basis: 'workspace-delta', files: ['other-agent.ts'] },
  ]);
});

test('literal file operations preserve attributable rename, delete and copy destinations', () => {
  expect(
    shellWritePaths(
      'mv old.ts renamed.ts; cp source.ts copied.ts; rm -f obsolete.ts; touch fresh.ts',
    ),
  ).toEqual(['old.ts', 'renamed.ts', 'copied.ts', 'obsolete.ts', 'fresh.ts']);
  expect(
    shellWritePaths(
      'Move-Item -LiteralPath old.ts -Destination renamed.ts; Copy-Item -Path source.ts -Destination copied.ts; Remove-Item -LiteralPath obsolete.ts',
    ),
  ).toEqual(['old.ts', 'renamed.ts', 'copied.ts', 'obsolete.ts']);
});

test('failed or interrupted shell calls retain partial native deltas without claiming applied edits', () => {
  for (const interrupted of [false, true]) {
    const rows = trace('/project', 'printf new > own.ts; exit 1', ['own.ts'])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    rows[2].toolUseResult.interrupted = interrupted;
    rows[2].message.content[0].is_error = !interrupted;
    const parsed = parseClaudeTranscript(
      rows.map((row) => JSON.stringify(row)).join('\n'),
      '/project',
    );
    expect(parsed.messages.filter((message) => message.role === 'edit')).toHaveLength(0);
    expect(parsed.fileObservationCandidates?.[0]).toMatchObject({
      basis: 'workspace-delta',
      toolOutcome: 'failed',
      diff: expect.stringContaining('+export const value = true;'),
    });
  }
});

test('workspace deltas retain native diff evidence without reading current or deleted files', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({
      version: 2,
      captureEnabled: true,
      captureSince: '2026-01-01T00:00:00.000Z',
    });
    enableToolCapture('claude', '2026-01-01T00:00:00.000Z');
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'workspace.jsonl'), trace(project, 'python build.py'));
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'claude', cutoff: '2099-01-01T00:00:00.000Z' });
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.summary.artifacts).toBe(0);
    expect(report.fileObservations).toHaveLength(1);
    expect(report.fileObservations![0]).toMatchObject({
      basis: 'workspace-delta',
      path: 'other-agent.ts',
      diff: expect.stringContaining('+export const value = true;'),
      observedAt: '2026-01-02T12:00:02.000Z',
    });
    expect(report.fileObservations![0]!.sha256).toBeUndefined();
    expect(store.verify().ok).toBe(true);
  }));

test('old misattributed shell deltas are projected without applied edits or changing raw hashes', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'workspace',
      cwd: project,
    });
    const prompt = store.append(session.id, {
      kind: 'prompt',
      origin: 'human',
      sourceId: 'prompt',
      text: 'Inspect the project.',
      ts: '2026-01-02T12:00:00.000Z',
    }).record!;
    store.append(session.id, {
      kind: 'conversation_event',
      sourceId: 'conversation:shell:use',
      ts: '2026-01-02T12:00:01.000Z',
      turnId: prompt.id,
      conversationEvent: {
        type: 'tool_use',
        toolUseId: 'shell',
        toolName: 'Bash',
        input: { command: 'cat package.json; ls -la' },
        sourceId: 'shell:use',
        sequence: 1,
        timestamp: '2026-01-02T12:00:01.000Z',
      },
    });
    const wrong = store.append(session.id, {
      kind: 'edit',
      file: join(project, 'other-agent.ts'),
      sourceId: `shell:edits#${join(project, 'other-agent.ts')}`,
      diff: '+export const value = true;',
      ts: '2026-01-02T12:00:02.000Z',
      turnId: prompt.id,
    }).record!;
    captureTranscript(
      store,
      session,
      parseClaudeTranscript(trace(project, 'cat package.json; ls -la'), project, {
        includeOutsideEdits: true,
      }),
      { since: '2026-01-03T00:00:00.000Z' },
    );
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.summary.artifacts).toBe(0);
    expect(report.fileObservations?.[0]).toMatchObject({
      basis: 'workspace-delta',
      diff: '+export const value = true;',
    });
    expect(store.query('SELECT hash FROM records WHERE id=?').get(wrong.id)).toEqual({
      hash: wrong.hash,
    });
    expect(store.verify().ok).toBe(true);
  }));

test('eligible replay supersedes a mistaken native shell edit with immutable workspace evidence', () =>
  fixture(async ({ project }) => {
    const since = '2026-01-01T00:00:00.000Z';
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const content = trace(project, 'cat package.json; ls -la');
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'workspace.jsonl'), content);
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'workspace',
      cwd: project,
    });
    captureTranscript(
      store,
      session,
      parseClaudeTranscript(content, project, { includeOutsideEdits: true }),
    );
    const sourceId = `shell:edits#${join(project, 'other-agent.ts')}`;
    const wrong = store.append(session.id, {
      kind: 'edit',
      sourceId,
      file: join(project, 'other-agent.ts'),
      diff: '+export const value = true;',
      ts: '2026-01-02T12:00:02.000Z',
    }).record!;
    await syncHistory(store, { tool: 'claude', cutoff: '2099-01-01T00:00:00.000Z' });
    expect(store.bySource(session.id, sourceId)?.kind).toBe('audit');
    expect(store.records().filter((record) => record.kind === 'edit')).toHaveLength(0);
    expect(store.query('SELECT hash FROM records WHERE id=?').get(wrong.id)).toEqual({
      hash: wrong.hash,
    });
    expect(
      buildHistoryReport(store, { kind: 'all' }).fileObservations?.[0],
    ).toMatchObject({
      basis: 'workspace-delta',
      diff: expect.stringContaining('+export const value = true;'),
    });
    expect(store.verify().ok).toBe(true);
  }));
