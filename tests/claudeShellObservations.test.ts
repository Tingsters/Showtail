import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellWritePaths } from '../packages/agent-traces/src/hooks/shellWrites.ts';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { HistoryStore, digest } from '../src/core/history.ts';
import { captureTranscript } from '../src/core/historyCapture.ts';
import { readClaudeSource } from '../src/core/nativeSourceCursor.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { syncHistory } from '../src/core/historySync.ts';
import { fixture } from './centralHelpers.ts';

const recorded = readFileSync(
  join(import.meta.dir, 'fixtures/claude-shell-partial-write.jsonl'),
  'utf8',
);
const since = '2026-01-01T00:00:00.000Z';
const cutoff = '2099-01-01T00:00:00.000Z';

function powershell(project: string, finished = true, diff = false) {
  return (
    [
      {
        type: 'user',
        uuid: 'ps-prompt',
        sessionId: 'powershell',
        cwd: project,
        timestamp: '2026-01-02T12:00:00.000Z',
        message: { content: 'Update the file.' },
      },
      {
        type: 'assistant',
        uuid: 'ps-use',
        sessionId: 'powershell',
        cwd: project,
        timestamp: '2026-01-02T12:00:01.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'ps-write',
              name: 'PowerShell',
              input: {
                command:
                  'Set-Content -LiteralPath actual.txt -Value new; Set-Content -Path .env -Value secret',
              },
            },
          ],
        },
      },
      ...(finished
        ? [
            {
              type: 'user',
              uuid: 'ps-result',
              sessionId: 'powershell',
              cwd: project,
              timestamp: '2026-01-02T12:00:02.000Z',
              toolUseResult: {
                stdout: '',
                stderr: '',
                interrupted: false,
                ...(diff
                  ? {
                      bashEditDiff: {
                        files: [
                          {
                            filePath: join(project, 'actual.txt'),
                            hunks: [
                              {
                                oldStart: 1,
                                oldLines: 1,
                                newStart: 1,
                                newLines: 1,
                                lines: ['-old', '+new'],
                              },
                            ],
                          },
                        ],
                      },
                    }
                  : {}),
              },
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'ps-write',
                    content: '',
                    is_error: false,
                  },
                ],
              },
            },
          ]
        : []),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

test('shell write hints ignore quoted instructions and here-doc contents', () => {
  expect(
    shellWritePaths(
      `printf 'echo > fake.txt' > real.txt\ncat > second.txt <<'EOF'\nSet-Content -Path fake2.txt hi\necho > fake3.txt\nEOF\nGet-Content real.txt`,
    ),
  ).toEqual(['real.txt', 'second.txt']);
  expect(
    shellWritePaths(
      `@'\nSet-Content -Path fake.txt hi\n'@ | Set-Content -LiteralPath 'actual file.txt'`,
    ),
  ).toEqual(['actual file.txt']);
  expect(
    shellWritePaths('Set-Content -LiteralPath $target -Value hi; echo hi > /dev/null'),
  ).toEqual([]);
});

test('recorded partial Bash outcome supplies candidates, not successful edits', () => {
  const parsed = parseClaudeTranscript(recorded, '/project');
  expect(parsed.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
    'Create a greeting module and run its tests.',
  ]);
  expect(parsed.messages.filter((m) => m.role === 'edit')).toEqual([]);
  expect(parsed.fileObservationCandidates).toMatchObject([
    {
      sourceId: 'partial-shell',
      toolName: 'Bash',
      files: ['greeting.mjs', 'greeting.test.mjs'],
      toolOutcome: 'failed',
    },
  ]);
  expect(parsed.messages.find((m) => m.sourceId === 'partial-shell')?.isError).toBe(true);
});

test('PowerShell native outcomes retain write hints while unfinished tools remain attempts', () => {
  expect(
    parseClaudeTranscript(powershell('/project', false), '/project')
      .fileObservationCandidates,
  ).toBeUndefined();
  const success = parseClaudeTranscript(powershell('/project'), '/project');
  expect(success.fileObservationCandidates?.[0]).toMatchObject({
    toolName: 'PowerShell',
    toolOutcome: 'succeeded',
  });
  expect(success.messages.filter((m) => m.role === 'edit')).toHaveLength(0);
  const structured = parseClaudeTranscript(
    powershell('/project', true, true),
    '/project',
  );
  expect(structured.messages.find((m) => m.role === 'edit')?.edits?.[0]?.diff).toContain(
    '+new',
  );
  expect(structured.fileObservationCandidates?.flatMap((c) => c.files)).not.toContain(
    'actual.txt',
  );
});

test('shell observations respect capture settings and sensitive paths', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const source = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(project, 'actual.txt'), 'new');
    writeFileSync(join(project, '.env'), 'private');
    writeFileSync(join(source, 'powershell.jsonl'), powershell(project));
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'claude', cutoff });
    const observed = buildHistoryReport(store, { kind: 'all' }).fileObservations!;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ path: 'actual.txt', toolOutcome: 'succeeded' });
    expect(store.records().some((r) => r.file?.endsWith('.env'))).toBe(false);
  }));

test('a disabled code-capture setting does not read shell write candidates', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({
      version: 2,
      captureEnabled: true,
      captureSince: since,
      settings: { captureCode: false },
    });
    enableToolCapture('claude', since);
    const source = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(project, 'actual.txt'), 'new');
    writeFileSync(join(source, 'powershell.jsonl'), powershell(project));
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(buildHistoryReport(store, { kind: 'all' }).fileObservations).toHaveLength(0);
  }));

test('native shell results yield timestamped observations without inventing applied revisions', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const source = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'native-shell.jsonl'), recorded);
    writeFileSync(
      join(project, 'greeting.mjs'),
      'created before the test command failed',
    );
    writeFileSync(join(project, 'greeting.test.mjs'), 'also created');
    // The native fixture's cwd is supplied by its parent transcript envelope.
    const native = recorded
      .trim()
      .split('\n')
      .map((line) => JSON.stringify({ ...JSON.parse(line), cwd: project }))
      .join('\n');
    writeFileSync(join(source, 'native-shell.jsonl'), native);
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'claude', cutoff });
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.fileObservations).toHaveLength(2);
    expect(
      report.fileObservations?.every(
        (o) =>
          o.basis === 'shell-write-attempt' &&
          o.toolOutcome === 'failed' &&
          o.sha256?.length === 64 &&
          !!o.toolCallId,
      ),
    ).toBe(true);
    expect(report.summary.artifacts).toBe(0);
    expect(report.turns.flatMap((t) => t.codeChanges)).toHaveLength(0);
    expect(store.records().filter((r) => r.kind === 'edit')).toHaveLength(0);
    const original = store.records().map((r) => ({ id: r.id, hash: r.hash }));
    writeFileSync(join(project, 'greeting.mjs'), 'later manual content');
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(store.records().map((r) => ({ id: r.id, hash: r.hash }))).toEqual(original);
    expect(store.verify().ok).toBe(true);
  }));

test('a reader upgrade replays earlier turns before applying new shell observation logic', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const source = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    const path = join(source, 'native-shell.jsonl');
    const content =
      recorded
        .trim()
        .split('\n')
        .map((line) => JSON.stringify({ ...JSON.parse(line), cwd: project }))
        .join('\n') +
      '\n' +
      JSON.stringify({
        type: 'user',
        uuid: 'later',
        sessionId: 'native-shell',
        cwd: project,
        timestamp: '2026-01-02T12:01:00.000Z',
        message: { content: 'Continue.' },
      }) +
      '\n';
    writeFileSync(path, content);
    writeFileSync(join(project, 'greeting.mjs'), 'created');
    writeFileSync(join(project, 'greeting.test.mjs'), 'test');
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'claude-code',
      nativeSessionId: 'native-shell',
      cwd: project,
      transcriptPath: path,
    });
    captureTranscript(
      store,
      session,
      parseClaudeTranscript(content, project, { includeOutsideEdits: true }),
      { since },
    );
    const nativeRows = store.records().map((r) => ({ id: r.id, hash: r.hash }));
    const key = `source-cursor:claude-code:${digest(path)}`;
    const st = statSync(path);
    store.setMeta(
      key,
      JSON.stringify({
        version: 1,
        size: st.size,
        mtime: st.mtimeMs,
        ino: st.ino,
        since,
      }),
    );
    store.setMeta(`${key}:tail`, readClaudeSource(path).checkpoint);
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(buildHistoryReport(store, { kind: 'all' }).fileObservations).toHaveLength(2);
    for (const row of nativeRows)
      expect(store.records().some((r) => r.id === row.id && r.hash === row.hash)).toBe(
        true,
      );
  }));

test('a failed observation commit leaves the source eligible for retry', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('claude', since);
    const source = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(source, { recursive: true });
    const path = join(source, 'powershell.jsonl');
    writeFileSync(path, powershell(project));
    writeFileSync(join(project, 'actual.txt'), 'new');
    using store = new HistoryStore();
    const append = store.append.bind(store);
    store.append = (sessionId, input, options) => {
      if (input.provenance?.source === 'native-shell-write-observation')
        throw new Error('simulated SQLite contention');
      return append(sessionId, input, options);
    };
    const failed = await syncHistory(store, { tool: 'claude', cutoff });
    expect(failed.issues).toContainEqual({
      tool: 'claude-code',
      code: 'SOURCE_READ_FAILED',
    });
    expect(store.meta(`source-cursor:claude-code:${digest(path)}`)).toBeUndefined();
    store.append = append;
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(buildHistoryReport(store, { kind: 'all' }).fileObservations).toHaveLength(1);
    const count = store.records().length;
    await syncHistory(store, { tool: 'claude', cutoff });
    expect(store.records()).toHaveLength(count);
    expect(store.verify().ok).toBe(true);
  }));
