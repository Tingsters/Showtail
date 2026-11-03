import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import {
  disableToolCapture,
  enableToolCapture,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { HistoryStore } from '../src/core/history.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { syncHistory } from '../src/core/historySync.ts';
import { blockFor } from '../src/core/managedBlock.ts';
import { collectObservations } from '../src/core/passiveCollector.ts';
import { observationCount, observe, observerQueue } from '../src/core/passiveObserver.ts';
import {
  reportSkillFile,
  retireInstructions,
  setReportDiscovery,
  writeReportSkill,
} from '../src/core/reportDiscovery.ts';
import { fixture } from './centralHelpers.ts';

const before = '2026-01-01T00:00:00.000Z';
const at = '2026-11-01T12:00:00.000Z';
function transcript(project: string) {
  return (
    [
      {
        type: 'user',
        uuid: 'prompt',
        sessionId: 'native-thread',
        timestamp: at,
        cwd: project,
        message: { content: 'Build the project' },
      },
      {
        type: 'assistant',
        uuid: 'answer',
        timestamp: at,
        message: {
          model: 'claude-test',
          content: [
            {
              type: 'tool_use',
              id: 'edit',
              name: 'Write',
              input: { file_path: join(project, 'index.ts'), content: 'new' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: at,
        toolUseResult: {
          filePath: join(project, 'index.ts'),
          originalFile: '',
          content: 'new',
        },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'success' }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  );
}
test('hook intake queues no prompt, tool arguments, output, or permission decisions', () =>
  fixture(({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    observe(
      'user-prompt',
      { session_id: 'native-thread', prompt: 'DO NOT STORE' },
      'claude',
      false,
    );
    expect(observationCount()).toBe(0);
    observe(
      'post-edit',
      {
        session_id: 'native-thread',
        cwd: project,
        prompt: 'DO NOT STORE',
        tool_input: { file_path: join(project, 'index.ts'), content: 'sk-secret-value' },
        tool_response: { stdout: 'DO NOT STORE' },
      },
      'claude',
      false,
    );
    const content = readFileSync(
      join(observerQueue(), readdirSync(observerQueue())[0]!),
      'utf8',
    );
    expect(content).not.toContain('DO NOT STORE');
    expect(content).not.toContain('sk-secret-value');
    expect(JSON.parse(content).files).toEqual([join(project, 'index.ts')]);
  }));
test('queued capture is cancelled across pause and reconnect epochs', () =>
  fixture(async ({ dir, project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    enableToolCapture('claude', before);
    const path = join(dir, 'source.jsonl');
    writeFileSync(path, transcript(project));
    observe(
      'stop',
      { session_id: 'native-thread', cwd: project, transcript_path: path },
      'claude',
      false,
    );
    disableToolCapture('claude');
    enableToolCapture('claude', at);
    await collectObservations();
    using store = new HistoryStore();
    expect(store.records()).toHaveLength(0);
    expect(observationCount()).toBe(0);
    expect(existsSync(join(observerQueue(), 'worker.lock'))).toBe(false);
  }));
test('native collection works without a reporting skill, is replay safe, and preserves hashes', () =>
  fixture(async ({ dir, project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    setReportDiscovery('claude', false);
    writeReportSkill('claude');
    expect(existsSync(reportSkillFile('claude'))).toBe(false);
    const path = join(dir, 'source.jsonl');
    writeFileSync(path, transcript(project));
    const payload = { session_id: 'native-thread', cwd: project, transcript_path: path };
    observe('stop', payload, 'claude', false);
    await collectObservations();
    using store = new HistoryStore();
    expect(
      store
        .records()
        .filter((r) => r.kind === 'prompt')
        .map((r) => r.text),
    ).toEqual(['Build the project']);
    expect(store.records().find((r) => r.kind === 'edit')?.diff).toContain('+new');
    const count = store.records().length;
    observe('stop', payload, 'claude', false);
    await collectObservations();
    expect(store.records()).toHaveLength(count);
    expect(store.verify().ok).toBe(true);
  }));
test('asynchronous hashes supplement native edits without inflating report revision counts', () =>
  fixture(async ({ dir, project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    const path = join(dir, 'source.jsonl');
    writeFileSync(path, transcript(project));
    const file = join(project, 'index.ts');
    writeFileSync(file, 'new');
    observe(
      'post-edit',
      {
        session_id: 'native-thread',
        cwd: project,
        transcript_path: path,
        tool_input: { file_path: file },
      },
      'claude',
      false,
    );
    await collectObservations();
    using store = new HistoryStore();
    expect(store.records().filter((r) => r.kind === 'edit')).toHaveLength(1);
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.summary.artifacts).toBe(1);
    expect(report.fileObservations).toHaveLength(1);
    expect(report.fileObservations![0]!.sha256).toHaveLength(64);
    const observed = store
      .records({ kind: 'all' }, { includeSuperseded: true })
      .find((r) => r.duplicateOf)!;
    store.append(observed.sessionId, {
      kind: 'edit',
      duplicateOf: observed.duplicateOf,
      file: observed.file,
      sha256: observed.sha256,
      ts: observed.ts,
      turnId: observed.turnId,
      sourceId: observed.sourceId,
      tags: observed.tags,
      provenance: observed.provenance,
    });
    expect(store.records().filter((r) => r.kind === 'edit')).toHaveLength(1);
    expect(store.record(observed.duplicateOf!)?.kind).toBe('edit');
    expect(store.verify().ok).toBe(true);
  }));

test('sync discovers previously unknown sessions and does not backfill before consent', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    enableToolCapture('claude', before);
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'native-thread.jsonl'), transcript(project));
    using store = new HistoryStore();
    const result = await syncHistory(store, { tool: 'claude' });
    expect(result.imported).toBeGreaterThan(0);
    expect((await syncHistory(store, { tool: 'claude' })).imported).toBe(0);
    expect(store.verify().ok).toBe(true);
  }));
test('parent notifications collect native subagent work without inventing student prompts', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: before });
    enableToolCapture('claude', before);
    const root = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace');
    const childDir = join(root, 'parent', 'subagents');
    mkdirSync(childDir, { recursive: true });
    const parent = join(root, 'parent.jsonl');
    writeFileSync(
      parent,
      JSON.stringify({
        type: 'user',
        uuid: 'parent-prompt',
        sessionId: 'parent',
        cwd: project,
        timestamp: at,
        message: { content: 'Build this project' },
      }) + '\n',
    );
    const child = transcript(project)
      .trim()
      .split('\n')
      .map((line) => ({
        ...JSON.parse(line),
        sessionId: 'parent',
        cwd: project,
        isSidechain: true,
        agentId: 'child',
      }));
    child[0].message.content = 'Delegated work';
    writeFileSync(
      join(childDir, 'agent-child.jsonl'),
      child.map((line) => JSON.stringify(line)).join('\n') + '\n',
    );
    observe(
      'stop',
      { session_id: 'parent', cwd: project, transcript_path: parent },
      'claude',
      false,
    );
    await collectObservations();
    using store = new HistoryStore();
    expect(
      store
        .records()
        .filter((r) => r.kind === 'prompt')
        .map((r) => r.text),
    ).toEqual(['Build this project']);
    expect(store.records().filter((r) => r.kind === 'edit')).toHaveLength(1);
    expect(
      store.sessions().find((s) => s.nativeSessionId === 'parent:agent:child')
        ?.parentNativeSessionId,
    ).toBe('parent');
    expect(
      store.sessions().find((s) => s.nativeSessionId === 'parent')?.transcriptPath,
    ).toBe(parent);
    expect(buildHistoryReport(store, { kind: 'all' }).turns).toHaveLength(1);
    expect(store.verify().ok).toBe(true);
  }));

test('retiring an edited managed block backs it up and preserves outside bytes', () =>
  fixture(({ dir, home }) => {
    const path = join(dir, 'AGENTS.md');
    const text =
      'User rules\r\n' + blockFor('old capture instructions') + '\r\nOther rules\r\n';
    writeFileSync(path, text.replace('old capture', 'customized capture'));
    expect(retireInstructions(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('User rules\r\n\r\nOther rules\r\n');
    const backup = join(home, 'maintenance', 'passive-capture');
    expect(readdirSync(backup)).toHaveLength(1);
    expect(retireInstructions(path)).toBe(false);
  }));
test('native Claude results distinguish applied edits, failed attempts and plans injected by the host', () => {
  const content = [
    {
      type: 'assistant',
      timestamp: at,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'failed',
            name: 'Write',
            input: { file_path: '/project/no.ts' },
          },
          { type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: {} },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'failed',
            is_error: true,
            content: 'denied',
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at,
      toolUseResult: { plan: 'The actual plan' },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'plan',
            content: 'User has approved your plan',
          },
        ],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  const parsed = parseClaudeTranscript(content, '/project', {
    includeOutsideEdits: true,
  });
  expect(parsed.messages.some((m) => m.role === 'edit')).toBe(false);
  expect(parsed.messages.find((m) => m.sourceId === 'failed')?.isError).toBe(true);
  expect(parsed.messages.find((m) => m.role === 'plan')?.text).toContain(
    'The actual plan',
  );
});
