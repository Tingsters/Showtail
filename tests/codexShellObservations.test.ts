import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { threadToTranscript } from '../src/core/codexAppServer.ts';
import { parseCodexRollout } from '../src/core/codexTranscript.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { HistoryStore } from '../src/core/history.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { syncHistory } from '../src/core/historySync.ts';
import { fixture } from './centralHelpers.ts';

const start = Date.parse('2026-01-02T12:00:01.000Z');
const finish = start + 1000;
function content(project: string, status = 'completed', exit = 0) {
  const command = `Set-Content -LiteralPath '${join(project, 'shell-only.txt')}' -Value 'observed shell state' -NoNewline`;
  const frame = (item: unknown) => ({
    timestamp: new Date(finish).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'shell',
      turn_id: 'turn',
      started_at_ms: start,
      completed_at_ms: finish,
      item,
    },
  });
  return (
    [
      {
        timestamp: new Date(start - 1000).toISOString(),
        type: 'session_meta',
        payload: { id: 'shell', cwd: project, source: 'cli' },
      },
      frame({
        type: 'UserMessage',
        id: 'prompt',
        content: [{ type: 'text', text: 'Use PowerShell to create the file.' }],
      }),
      frame({
        type: 'CommandExecution',
        id: 'native-command',
        command: ['pwsh.exe', '-Command', command],
        cwd: pathToFileURL(project).href,
        parsed_cmd: [{ type: 'unknown', cmd: command }],
        status,
        exit_code: exit,
        aggregated_output: '',
      }),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

test('recorded Codex CommandExecution argv and parsed_cmd retain shell evidence without a fabricated diff', () =>
  fixture(({ project }) => {
    const parsed = parseCodexRollout(content(project), project, {
      includeOutsideEdits: true,
    });
    expect(parsed.fileObservationCandidates).toMatchObject([
      { files: [join(project, 'shell-only.txt')], toolOutcome: 'succeeded' },
    ]);
    expect(
      parsed.messages.find((message) => message.role === 'tool_call')?.text,
    ).toContain('Set-Content');
    expect(parsed.messages.filter((message) => message.role === 'edit')).toHaveLength(0);
    const use = parsed.events?.find((event) => event.type === 'tool_use');
    expect(use?.input).toMatchObject({ cwd: project });
  }));

test('API commandActions supply runtime commands while outer code-mode JS is ignored', () => {
  const native = threadToTranscript(
    'shell',
    [
      {
        item: {
          type: 'commandExecution',
          id: 'command',
          command: '"pwsh.exe" "-Command" "escaped display"',
          cwd: '/project',
          status: 'completed',
          exitCode: 0,
          commandActions: [
            { type: 'unknown', command: 'Set-Content -LiteralPath actual.txt -Value hi' },
          ],
        },
        startedAtMs: start,
        completedAtMs: finish,
      },
    ],
    { root: '/project', includeOutsideEdits: true },
  );
  expect(native.fileObservationCandidates?.[0]?.files[0]).toMatch(/actual\.txt$/);
  const wrapper = threadToTranscript(
    'shell',
    [
      {
        item: {
          type: 'toolCall',
          id: 'wrapper',
          tool: 'exec',
          input: 'text(await tools.exec_command({cmd:"Set-Content -Path fake.txt hi"}));',
        },
        startedAtMs: start,
        completedAtMs: finish,
      },
    ],
    { root: '/project' },
  );
  expect(wrapper.fileObservationCandidates).toBeUndefined();
});

test('failed shell commands retain uncertainty and running commands have no file observation', () =>
  fixture(({ project }) => {
    const failed = parseCodexRollout(content(project, 'failed', 1), project);
    expect(failed.fileObservationCandidates?.[0]?.toolOutcome).toBe('failed');
    expect(failed.messages.filter((message) => message.role === 'edit')).toHaveLength(0);
    expect(
      parseCodexRollout(content(project, 'inProgress'), project)
        .fileObservationCandidates,
    ).toBeUndefined();
  }));

test('native Codex shell capture records separate observed state and remains replay safe', () =>
  fixture(async ({ project }) => {
    const since = '2026-01-01T00:00:00.000Z';
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('codex', since);
    const sources = join(process.env.CODEX_HOME!, 'sessions');
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, 'rollout-shell.jsonl'), content(project));
    writeFileSync(join(project, 'shell-only.txt'), 'observed shell state');
    using store = new HistoryStore();
    await syncHistory(store, { tool: 'codex', cutoff: '2099-01-01T00:00:00.000Z' });
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.fileObservations).toHaveLength(1);
    expect(report.fileObservations![0]).toMatchObject({
      basis: 'shell-write-attempt',
      toolOutcome: 'succeeded',
      path: 'shell-only.txt',
    });
    expect(report.fileObservations![0]!.toolCallId).toBeDefined();
    expect(report.summary.artifacts).toBe(0);
    const ids = store.records().map((record) => record.id);
    await syncHistory(store, { tool: 'codex', cutoff: '2099-01-01T00:00:00.000Z' });
    expect(store.records().map((record) => record.id)).toEqual(ids);
    expect(store.verify().ok).toBe(true);
  }));
