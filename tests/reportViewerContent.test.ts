import { expect, test } from 'bun:test';
import { buildViewerPayload } from '../src/core/report/viewerPayload.ts';
import { renderViewerPayload } from '../src/core/report/viewerCodec.ts';
import type { ConversationEvent, ReportData } from '../src/types.ts';
import type { ReportRenderOptions } from '../src/core/report/markdown.ts';
import { readViewer } from './viewerHelpers.ts';

function report(events: ConversationEvent[]): ReportData {
  return {
    schemaVersion: 3,
    displayName: 'Viewer content fixture',
    project: null,
    generatedAt: '2026-01-01T00:00:00.000Z',
    scope: null,
    summary: { sessions: 1, events: events.length, artifacts: 0, plans: 0, decisions: 0 },
    contributors: [],
    tools: [],
    models: [],
    toolTimeline: [],
    plans: [],
    redactionCount: 0,
    authorship: 'Fixture',
    turns: [
      {
        prompt: {
          id: 'prompt-record',
          sourceId: 'prompt-native',
          type: 'prompt',
          text: 'Repeated input',
          timestamp: '2026-01-01T00:00:00.000Z',
          actorSlug: 'author',
        },
        sessionId: 'session',
        actorSlug: 'author',
        tool: 'codex',
        events,
        aiOutputs: [],
        toolCalls: [],
        decisions: [],
        plans: [],
        codeChanges: [],
      },
    ],
  };
}

function decode(data: ReportData, options?: ReportRenderOptions) {
  const built = buildViewerPayload(data, options);
  return readViewer(renderViewerPayload(built.index, built.blocks));
}

test('the lazy payload retains conflicting structured assistant events with the same native identity', () => {
  const data = report([
    { type: 'assistant_text', sourceId: 'native-ai', sequence: 0, text: 'First payload' },
    {
      type: 'assistant_text',
      sourceId: 'native-ai',
      sequence: 1,
      text: 'Conflicting payload',
    },
  ]);
  const { index, texts } = decode(data);
  const contents = index.turns[0]!.itemIds.map((id) =>
    texts.get(index.items[id]!.textRef!),
  );
  expect(contents).toContain('First payload');
  expect(contents).toContain('Conflicting payload');
});

test('a distinct native user identity survives even when its text equals the opening prompt', () => {
  const data = report([
    { type: 'user_text', sourceId: 'prompt-native', sequence: 0, text: 'Repeated input' },
    {
      type: 'user_text',
      sourceId: 'another-native-input',
      sequence: 1,
      text: 'Repeated input',
    },
  ]);
  const { index } = decode(data);
  expect(
    Object.values(index.items).some((item) => item.sourceId === 'another-native-input'),
  ).toBe(true);
});

test('native result channels and outcome remain available when the display call lacks them', () => {
  const data = report([
    {
      type: 'tool_result',
      sourceId: 'call:result',
      toolUseId: 'call',
      sequence: 0,
      stdout: 'Captured stdout',
      stderr: 'Captured stderr',
      exitCode: 7,
      isError: true,
    },
  ]);
  data.turns[0]!.toolCalls = [
    {
      id: 'tool-record',
      sourceId: 'call',
      type: 'tool_call',
      text: 'Run command',
      actorSlug: 'author',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ];
  const { index, texts } = decode(data);
  const contents = index.turns[0]!.itemIds.flatMap((id) => {
    const item = index.items[id]!;
    return [item.textRef, item.resultRef, ...(item.rawRefs ?? [])].flatMap((ref) =>
      ref ? [texts.get(ref)!] : [],
    );
  }).join('\n');
  expect(contents).toContain('Captured stdout');
  expect(contents).toContain('Captured stderr');
  expect(contents).toContain('7');
  expect(index.items['tool-record']!.isError).toBe(true);
  expect(texts.get(index.items['tool-record']!.textRef!)).toBe('Run command');
  expect(texts.get(index.items['tool-record']!.resultRef!)).toContain('Captured stdout');
});

test('the opening prompt retains its native source identity in the portable index', () => {
  const { index } = decode(
    report([
      {
        type: 'user_text',
        sourceId: 'prompt-native',
        sequence: 0,
        text: 'Repeated input',
      },
    ]),
  );
  expect(index.turns[0]).toMatchObject({
    id: 'prompt-record',
    sourceId: 'prompt-native',
  });
});

test('a conflicting native prompt payload is retained even when its native ID matches the opener', () => {
  const { index, texts } = decode(
    report([
      {
        type: 'user_text',
        sourceId: 'prompt-native',
        sequence: 0,
        text: 'Conflicting input',
      },
    ]),
  );
  expect(texts.get(index.turns[0]!.promptRef!)).toBe('Repeated input');
  expect(
    index.turns[0]!.itemIds.some(
      (id) => texts.get(index.items[id]!.textRef!) === 'Conflicting input',
    ),
  ).toBe(true);
});

test('per-turn recap duration, tokens, cache usage and branch survive without recap narration', () => {
  const data = report([]);
  data.turns[0]!.recap = {
    id: 'recap-record',
    sourceId: 'recap-native',
    type: 'recap',
    text: '',
    actorSlug: 'author',
    timestamp: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    inputTokens: 125,
    outputTokens: 51,
    cacheReadTokens: 2000,
    cacheCreationTokens: 301,
    gitBranch: 'feature/portable-viewer',
  };
  const { index } = decode(data);
  expect(index.turns[0]).toMatchObject({
    recap: {
      sourceId: 'recap-native',
      durationMs: 60000,
      inputTokens: 125,
      outputTokens: 51,
      cacheReadTokens: 2000,
      cacheCreationTokens: 301,
      gitBranch: 'feature/portable-viewer',
    },
  });
});

test('AI-off omits narration from both compressed texts and metadata without losing prompts or edits', () => {
  const data = report([
    {
      type: 'assistant_text',
      sourceId: 'native-ai',
      sequence: 0,
      text: 'Structured narration sentinel',
    },
  ]);
  data.turns[0]!.aiOutputs = [
    {
      id: 'ai-record',
      type: 'ai_output',
      sourceId: 'native-display-ai',
      text: 'Display narration sentinel',
      actorSlug: 'author',
      timestamp: '2026-01-01T00:00:01.000Z',
    },
  ];
  data.turns[0]!.codeChanges = [
    {
      path: 'main.ts',
      timestamp: '2026-01-01T00:00:02.000Z',
      diff: '+retained',
      revisions: [
        {
          recordId: 'revision-record',
          timestamp: '2026-01-01T00:00:02.000Z',
          diff: '+retained',
        },
      ],
    },
  ];
  data.turns[0]!.recap = {
    id: 'recap-record',
    type: 'recap',
    text: 'Recap narration sentinel',
    actorSlug: 'author',
    timestamp: '2026-01-01T00:00:03.000Z',
    durationMs: 3000,
  };
  const { index, texts } = decode(data, { ai: 'off' });
  const embedded = JSON.stringify(index) + [...texts.values()].join('\n');
  expect(embedded).not.toContain('Structured narration sentinel');
  expect(embedded).not.toContain('Display narration sentinel');
  expect(embedded).not.toContain('Recap narration sentinel');
  expect(index.turns[0]!.recap?.durationMs).toBe(3000);
  expect(index.turns).toHaveLength(1);
  expect(texts.get(index.turns[0]!.promptRef!)).toBe('Repeated input');
  expect(index.items['revision-record']!.recordId).toBe('revision-record');
  expect(texts.get(index.items['revision-record']!.textRef!)).toBe('+retained');
});

test('conflicting native variants keep their original timestamps and identities', () => {
  const { index, texts } = decode(
    report([
      {
        type: 'assistant_text',
        sourceId: 'native-ai',
        sequence: 4,
        timestamp: '2026-01-01T00:00:04.000Z',
        text: 'First variant',
      },
      {
        type: 'assistant_text',
        sourceId: 'native-ai',
        sequence: 8,
        timestamp: '2026-01-01T00:00:08.000Z',
        text: 'Later variant',
      },
    ]),
  );
  expect(
    index.turns[0]!.itemIds.map((id) => ({
      sourceId: index.items[id]!.sourceId,
      timestamp: index.items[id]!.timestamp,
      text: texts.get(index.items[id]!.textRef!),
    })),
  ).toEqual([
    {
      sourceId: 'native-ai',
      timestamp: '2026-01-01T00:00:04.000Z',
      text: 'First variant',
    },
    {
      sourceId: 'native-ai',
      timestamp: '2026-01-01T00:00:08.000Z',
      text: 'Later variant',
    },
  ]);
});

test('a displayed plan keeps the native snapshot identity rather than only its text', () => {
  const data = report([
    {
      type: 'plan_snapshot',
      sourceId: 'native-plan:snapshot',
      sequence: 4,
      timestamp: '2026-01-01T00:00:04.000Z',
      plan: '# Captured plan',
    },
  ]);
  data.turns[0]!.plans = [
    {
      id: 'plan-record',
      sourceId: 'native-plan',
      type: 'plan',
      text: '# Captured plan',
      timestamp: '2026-01-01T00:00:04.000Z',
      actorSlug: 'author',
    },
  ];
  const { index } = decode(data);
  expect(JSON.stringify(index)).toContain('native-plan:snapshot');
  expect(
    index.turns[0]!.itemIds.filter((id) => index.items[id]!.kind === 'plan'),
  ).toHaveLength(1);
});

test('linked file-state supplements retain their identity and evidence without adding applied work', () => {
  const data = report([]);
  data.turns[0]!.codeChanges = [
    {
      path: 'main.ts',
      capturedOnly: true,
      timestamp: '2026-01-01T00:00:01.000Z',
      diff: '+retained',
      revisions: [
        {
          recordId: 'native-edit',
          timestamp: '2026-01-01T00:00:01.000Z',
          diff: '+retained',
        },
      ],
    },
  ];
  data.fileObservations = [
    {
      recordId: 'linked-observation',
      editId: 'native-edit',
      path: 'main.ts',
      sha256: 'a'.repeat(64),
      observedAt: '2026-01-01T00:00:02.000Z',
      basis: 'native-edit',
    },
  ];
  const { index } = decode(data);
  expect(index.observations).toEqual([]);
  expect(
    index.turns[0]!.itemIds.filter((id) => index.items[id]!.kind === 'revision'),
  ).toEqual(['native-edit']);
  const metadata = JSON.stringify(index);
  expect(metadata).toContain('linked-observation');
  expect(metadata).toContain('a'.repeat(64));
  expect(metadata).toContain('2026-01-01T00:00:02.000Z');
});
