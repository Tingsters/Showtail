import { expect, test } from 'bun:test';
import { projectReport } from '../src/core/report/projection.ts';
import type { ConversationEvent, Event, ReportData, Turn } from '../src/types.ts';

function event(
  id: string,
  type: Event['type'] = 'ai_output',
  patch: Partial<Event> = {},
): Event {
  return {
    id,
    type,
    sourceId: 'native',
    text: 'Same captured text',
    timestamp: '2026-01-02T12:00:00.000Z',
    actorSlug: 'author',
    tool: 'codex',
    ...patch,
  };
}

function turn(patch: Partial<Turn> = {}): Turn {
  return {
    prompt: event('prompt', 'prompt', { origin: 'human' }),
    aiOutputs: [],
    toolCalls: [],
    decisions: [],
    plans: [],
    codeChanges: [],
    events: [],
    sessionId: 'session',
    actorSlug: 'author',
    tool: 'codex',
    ...patch,
  };
}

function report(turns: Turn[], extra: Partial<ReportData> = {}): ReportData {
  return {
    schemaVersion: 3,
    project: null,
    displayName: 'Projection fixture',
    generatedAt: '2026-01-02T12:00:00.000Z',
    scope: null,
    summary: { sessions: 1, events: 0, artifacts: 0, decisions: 0, plans: 0 },
    contributors: [],
    tools: [],
    models: [],
    toolTimeline: [],
    turns,
    plans: [],
    redactionCount: 0,
    authorship: 'Fixture',
    ...extra,
  };
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

test('identical native display events merge with aliases while every prompt and revision remains', () => {
  const first = turn({
    aiOutputs: [event('ai-original'), event('ai-copy')],
    toolCalls: [event('tool-original', 'tool_call'), event('tool-copy', 'tool_call')],
    decisions: [
      event('decision-original', 'decision'),
      event('decision-copy', 'decision'),
    ],
    plans: [event('plan-original', 'plan'), event('plan-copy', 'plan')],
    codeChanges: [
      {
        path: 'index.ts',
        timestamp: '2026-01-02T12:00:01.000Z',
        diff: '+same',
        revisions: [
          {
            recordId: 'revision-a',
            timestamp: '2026-01-02T12:00:01.000Z',
            diff: '+same',
          },
          {
            recordId: 'revision-b',
            timestamp: '2026-01-02T12:00:02.000Z',
            diff: '+same',
          },
        ],
      },
    ],
  });
  const input = frozen(
    report([first, turn({ prompt: event('other-prompt', 'prompt') })]),
  );
  const snapshot = JSON.stringify(input);
  const projected = projectReport(input);
  expect(projected.data.turns.map((t) => t.prompt.id)).toEqual([
    'prompt',
    'other-prompt',
  ]);
  for (const key of ['aiOutputs', 'toolCalls', 'decisions', 'plans'] as const)
    expect(projected.data.turns[0]![key]).toHaveLength(1);
  expect(projected.data.turns[0]!.codeChanges).toEqual(first.codeChanges);
  expect(
    projected.data.turns[0]!.codeChanges[0]!.revisions?.map((r) => r.recordId),
  ).toEqual(['revision-a', 'revision-b']);
  expect({ ...projected.aliases }).toEqual({
    'ai-copy': 'ai-original',
    'tool-copy': 'tool-original',
    'decision-copy': 'decision-original',
    'plan-copy': 'plan-original',
  });
  expect(projected.duplicates).toHaveLength(4);
  expect(JSON.stringify(input)).toBe(snapshot);
});

test('structured identities merge despite different object order or projection sequence', () => {
  const first: ConversationEvent = {
    type: 'tool_use',
    sourceId: 'call:use',
    toolUseId: 'call',
    sequence: 1,
    input: { command: 'echo ok', options: { cwd: '/project', timeout: 10 } },
  };
  const second: ConversationEvent = {
    sequence: 8,
    toolUseId: 'call',
    type: 'tool_use',
    sourceId: 'call:use',
    input: { options: { timeout: 10, cwd: '/project' }, command: 'echo ok' },
  };
  const projected = projectReport(frozen(report([turn({ events: [first, second] })])));
  expect(projected.data.turns[0]!.events).toEqual([first]);
  expect(projected.duplicates).toEqual([
    {
      sessionId: 'session',
      actorSlug: 'author',
      tool: 'codex',
      nativeId: 'call:use',
      part: 'structured:tool_use',
      canonicalSequence: 1,
      aliasSequence: 8,
    },
  ]);
});

test('identical text with distinct or missing native IDs remains distinct', () => {
  const entries = [
    event('a', 'ai_output', { sourceId: 'native-a' }),
    event('b', 'ai_output', { sourceId: 'native-b' }),
    event('c', 'ai_output', { sourceId: undefined }),
    event('d', 'ai_output', { sourceId: undefined }),
  ];
  const projected = projectReport(report([turn({ aiOutputs: entries })]));
  expect(projected.data.turns[0]!.aiOutputs).toEqual(entries);
  expect(projected.duplicates).toEqual([]);
});

test('conflicting timestamps, content, model, origin, error or payload are never hidden', () => {
  const entries = [
    event('base'),
    event('text', 'ai_output', { text: 'Changed' }),
    event('time', 'ai_output', { timestamp: '2026-01-02T12:00:01.000Z' }),
    event('model', 'ai_output', { model: 'another-model' }),
    event('origin', 'ai_output', { origin: 'agent' }),
    event('error', 'ai_output', { isError: true }),
  ];
  const native: ConversationEvent[] = [
    { type: 'tool_result', sourceId: 'result', sequence: 0, content: 'first' },
    { type: 'tool_result', sourceId: 'result', sequence: 1, content: 'second' },
    {
      type: 'tool_result',
      sourceId: 'result',
      sequence: 2,
      content: 'second',
      isError: true,
    },
  ];
  const projected = projectReport(report([turn({ aiOutputs: entries, events: native })]));
  expect(projected.data.turns[0]!.aiOutputs).toEqual(entries);
  expect(projected.data.turns[0]!.events).toEqual(native);
  expect(projected.duplicates).toHaveLength(0);
});

test('a duplicate of a conflicting variant aliases that variant rather than the first identity', () => {
  const projected = projectReport(
    report([
      turn({
        aiOutputs: [
          event('first'),
          event('second', 'ai_output', { text: 'Other payload' }),
          event('second-copy', 'ai_output', { text: 'Other payload' }),
        ],
      }),
    ]),
  );
  expect(projected.data.turns[0]!.aiOutputs.map((e) => e.id)).toEqual([
    'first',
    'second',
  ]);
  expect(projected.aliases['second-copy']).toBe('second');
});

test('session, author, tool, semantic part and established turn associations scope identity', () => {
  const turns = [
    turn({ aiOutputs: [event('a')], toolCalls: [event('tool', 'tool_call')] }),
    turn({ sessionId: 'other-session', aiOutputs: [event('b')] }),
    turn({ actorSlug: 'other-author', aiOutputs: [event('c')] }),
    turn({ tool: 'claude-code', aiOutputs: [event('d')] }),
    turn({ prompt: event('second-turn-prompt', 'prompt'), aiOutputs: [event('e')] }),
  ];
  const projected = projectReport(report(turns));
  expect(projected.data.turns.flatMap((t) => t.aiOutputs).map((e) => e.id)).toEqual([
    'a',
    'b',
    'c',
    'd',
    'e',
  ]);
  expect(projected.data.turns[0]!.toolCalls).toHaveLength(1);
  expect(projected.duplicates).toHaveLength(0);
});

test('unknown semantic fields and array order are retained as conflicts', () => {
  const entries = [
    { ...event('a'), futureField: { versions: [1, 2] } },
    { ...event('b'), futureField: { versions: [2, 1] } },
  ];
  expect(
    projectReport(report([turn({ aiOutputs: entries })])).data.turns[0]!.aiOutputs,
  ).toEqual(entries);
});

test('unattributed work uses the same projection without guessing a prompt or changing export metadata', () => {
  const { prompt: _, ...work } = turn({
    toolCalls: [event('original', 'tool_call'), event('copy', 'tool_call')],
  });
  const input = report([], { unattributedWork: [work] });
  const projected = projectReport(frozen(input));
  expect(projected.data.unattributedWork?.[0]?.toolCalls.map((e) => e.id)).toEqual([
    'original',
  ]);
  expect(projected.data.unattributedWork?.[0]).not.toHaveProperty('prompt');
  expect(projected.data.summary).toEqual(input.summary);
  expect(projected.aliases.copy).toBe('original');
});
