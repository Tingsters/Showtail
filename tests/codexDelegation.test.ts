import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readThreadTranscript } from '../src/core/codexAppServer.ts';
import { parseCodexRollout, parseCodexTranscript } from '../src/core/codexTranscript.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { HistoryStore } from '../src/core/history.ts';
import { captureTranscript } from '../src/core/historyCapture.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { collectObservations } from '../src/core/passiveCollector.ts';
import { observe } from '../src/core/passiveObserver.ts';
import { fixture } from './centralHelpers.ts';
import { supplementDelegatedCodexInputs } from '../src/plugins/codex.ts';

const since = '2026-01-01T00:00:00.000Z';
function rollout(id: string, cwd: string, parent?: string) {
  const frame = (item: unknown) => ({
    timestamp: '2026-01-02T12:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', turn_id: `turn-${id}`, item },
  });
  return (
    [
      {
        timestamp: '2026-01-02T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id,
          cwd,
          source: parent
            ? {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: parent,
                    depth: 1,
                    agent_path: '/root/helper',
                  },
                },
              }
            : 'cli',
        },
      },
      ...(parent
        ? [
            {
              timestamp: '2026-01-02T12:00:01.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'Delegated input for the helper.' },
                ],
              },
            },
          ]
        : [
            frame({
              type: 'UserMessage',
              id: `input-${id}`,
              content: [
                {
                  type: 'text',
                  text: parent
                    ? 'Delegated input for the helper.'
                    : 'Build this project with a helper.',
                },
              ],
            }),
          ]),
      ...(parent
        ? [
            frame({
              type: 'FileChange',
              id: `edit-${id}`,
              status: 'completed',
              changes: {
                [join(cwd, `${id}.ts`)]: {
                  type: 'add',
                  unified_diff: `+export const ${id} = true;`,
                },
              },
            }),
          ]
        : []),
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  );
}

test('native Codex child metadata overrides the user-role human default', () => {
  const child = parseCodexTranscript(rollout('child', '/project', 'parent'), '/project');
  expect(child.parentNativeSessionId).toBe('parent');
  expect(child.messages.find((message) => message.role === 'user')?.origin).toBe('agent');
  expect(child.events.find((event) => event.type === 'user_text')?.origin).toBe('agent');
  const parent = parseCodexTranscript(rollout('parent', '/project'), '/project');
  expect(parent.parentNativeSessionId).toBeUndefined();
  expect(parent.messages.find((message) => message.role === 'user')?.origin).toBe(
    'human',
  );
});

test('API-only Codex subagents retain their native parent and input provenance', async () => {
  const calls: string[] = [];
  const read = await readThreadTranscript('child', {
    root: '/project',
    rpc: {
      async request(method) {
        calls.push(method);
        if (method === 'thread/items/list')
          return {
            data: [
              {
                turnId: 'turn',
                item: {
                  type: 'userMessage',
                  id: 'input',
                  content: [{ type: 'text', text: 'Delegated input' }],
                },
                startedAtMs: 1767355200000,
              },
            ],
            nextCursor: null,
          };
        if (method === 'thread/read')
          return {
            thread: {
              parentThreadId: 'parent',
              source: {
                subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } },
              },
            },
          };
        throw new Error(`unexpected ${method}`);
      },
      close() {},
    },
  });
  expect(read.transcript.parentNativeSessionId).toBe('parent');
  expect(read.transcript.messages[0]?.origin).toBe('agent');
  expect(calls).toEqual(['thread/items/list', 'thread/read']);
});

test('child API reads supplement delegated input only from the same native session', () => {
  const fallback = parseCodexRollout(rollout('child', '/project', 'parent'), '/project');
  const preferred = {
    ...fallback,
    messages: fallback.messages.filter((message) => message.role !== 'user'),
    events: fallback.events?.filter((event) => event.type !== 'user_text'),
  };
  supplementDelegatedCodexInputs(preferred, fallback);
  expect(preferred.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  expect(
    preferred.messages
      .filter((message) => message.role === 'user')
      .every((message) => message.origin === 'agent'),
  ).toBe(true);
  const other = {
    ...preferred,
    sessionId: 'different',
    messages: preferred.messages.filter((message) => message.role !== 'user'),
  };
  supplementDelegatedCodexInputs(other, fallback);
  expect(other.messages.filter((message) => message.role === 'user')).toHaveLength(0);
});

test('parent notifications collect Codex children and grandchildren without extra human prompts', () =>
  fixture(async ({ project }) => {
    writeGlobalConfig({ version: 2, captureEnabled: true, captureSince: since });
    enableToolCapture('codex', since);
    const native = join(process.env.CODEX_HOME!, 'sessions');
    mkdirSync(native, { recursive: true });
    for (const [id, parent] of [
      ['parent', undefined],
      ['child', 'parent'],
      ['grandchild', 'child'],
    ] as const)
      writeFileSync(join(native, `rollout-${id}.jsonl`), rollout(id, project, parent));
    observe('stop', { session_id: 'parent', cwd: project }, 'codex', false);
    await collectObservations();
    using store = new HistoryStore();
    const child = store
      .sessions()
      .find((session) => session.nativeSessionId === 'child')!;
    const grandchild = store
      .sessions()
      .find((session) => session.nativeSessionId === 'grandchild')!;
    expect(child?.parentNativeSessionId).toBe('parent');
    expect(grandchild?.parentNativeSessionId).toBe('child');
    expect(
      store
        .records()
        .filter((record) => record.kind === 'prompt')
        .map((record) => record.text),
    ).toEqual(['Build this project with a helper.']);
    expect(
      store
        .records({ kind: 'all' }, { sessionId: child.id })
        .some((record) => record.kind === 'tool_call' && record.origin === 'agent'),
    ).toBe(true);
    expect(store.records().filter((record) => record.kind === 'edit')).toHaveLength(2);
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.turns).toHaveLength(1);
    expect(
      report.coverage?.sources.find((source) => source.sessionId === child.id)
        ?.parentNativeSessionId,
    ).toBe('parent');
    expect(store.verify().ok).toBe(true);
  }));

test('replaying old child capture corrects attribution while preserving immutable rows', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'codex',
      nativeSessionId: 'child',
      cwd: project,
    });
    const parsed = parseCodexRollout(rollout('child', project, 'parent'), project);
    const old = store.append(session.id, {
      kind: 'prompt',
      origin: 'human',
      text: 'Delegated input for the helper.',
      sourceId: parsed.messages.find((message) => message.role === 'user')!.sourceId,
      ts: '2026-01-02T12:00:02.000Z',
    }).record!;
    captureTranscript(store, session, parsed);
    expect(store.session(session.id)?.parentNativeSessionId).toBe('parent');
    expect(store.records().filter((record) => record.kind === 'prompt')).toHaveLength(0);
    expect(store.query('SELECT hash FROM records WHERE id=?').get(old.id)).toEqual({
      hash: old.hash,
    });
    expect(store.verify().ok).toBe(true);
  }));

test('report projection labels known child input as agent work even outside the current capture epoch', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({
      tool: 'codex',
      nativeSessionId: 'child',
      cwd: project,
    });
    const parsed = parseCodexRollout(rollout('child', project, 'parent'), project);
    const input = parsed.messages.find((message) => message.role === 'user')!;
    const legacy = store.append(session.id, {
      kind: 'prompt',
      origin: 'human',
      text: input.text,
      sourceId: input.sourceId,
      ts: input.timestamp,
    }).record!;
    const event = store.append(session.id, {
      kind: 'conversation_event',
      sourceId: `conversation:${input.sourceId}`,
      turnId: legacy.id,
      ts: input.timestamp,
      conversationEvent: {
        type: 'user_text',
        origin: 'human',
        sourceId: input.sourceId,
        text: input.text,
        sequence: 0,
        timestamp: input.timestamp,
      },
    }).record!;
    captureTranscript(store, session, parsed, { since: '2026-01-03T00:00:00.000Z' });
    const report = buildHistoryReport(store, { kind: 'all' });
    expect(report.turns).toHaveLength(0);
    expect(report.unattributedWork?.flatMap((work) => work.toolCalls)).toContainEqual(
      expect.objectContaining({ origin: 'agent', text: input.text }),
    );
    expect(
      report.unattributedWork
        ?.flatMap((work) => work.events ?? [])
        .find((value) => value.type === 'user_text')?.origin,
    ).toBe('agent');
    for (const row of [legacy, event])
      expect(store.query('SELECT hash FROM records WHERE id=?').get(row.id)).toEqual({
        hash: row.hash,
      });
    expect(store.verify().ok).toBe(true);
  }));
