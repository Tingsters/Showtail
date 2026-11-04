/** A small, rich report whose features cannot pass by being absent. */
import type { Event, ReportData, Turn } from '../../src/types.ts';

export const PARITY_MARKDOWN = [
  '# Captured Markdown',
  '',
  'A **bold claim**, *careful emphasis*, `inlineCode()`, and [official docs](https://example.com/docs).',
  '',
  '> A captured quotation',
  '',
  '- First outer point',
  '  - Nested evidence',
  '- Second outer point',
  '',
  '| Item | Result |',
  '| --- | --- |',
  '| Rendered table | retained |',
  '',
  '```typescript',
  'const captured = "<script> stays literal";',
  '```',
  '',
  '[unsafe](javascript:alert(1)) and </script><script>window.__capturedExecuted=true</script> stay inert.',
].join('\n');

export function parityReportFixture(): ReportData {
  const stamp = (i: number, seconds = 0) =>
    new Date(Date.UTC(2026, 10, 3, 18, i, seconds)).toISOString();
  const event = (
    turn: number,
    id: string,
    type: Event['type'],
    text: string,
    extra: Partial<Event> = {},
  ): Event => ({
    id,
    type,
    text,
    timestamp: stamp(turn, 1),
    actorSlug: turn % 2 ? 'bob' : 'alice',
    tool: turn % 2 ? 'claude' : 'codex',
    ...extra,
  });
  const turns: Turn[] = Array.from({ length: 14 }, (_, i) => ({
    prompt: event(
      i,
      `parity-prompt-${i}`,
      'prompt',
      i === 0
        ? 'Build a readable report with all captured evidence.'
        : i === 1
          ? 'Preserve a captured zero and distinguish missing usage.'
          : i % 4 === 0
            ? 'Repeat this exact request.'
            : `Review step ${i}.`,
      { timestamp: stamp(i), model: i % 2 ? 'claude-opus-4-8' : 'gpt-5.5' },
    ),
    sessionId:
      i % 3 === 0 ? 'session-charlie' : i % 2 ? 'session-bravo' : 'session-alpha',
    actorSlug: i % 2 ? 'bob' : 'alice',
    tool: i % 2 ? 'claude' : 'codex',
    aiOutputs: [
      event(
        i,
        `parity-ai-${i}`,
        'ai_output',
        i === 0 ? PARITY_MARKDOWN : `AI response for step ${i}.`,
        { model: i % 2 ? 'claude-opus-4-8' : 'gpt-5.5' },
      ),
    ],
    decisions:
      i === 0
        ? [
            event(
              i,
              'parity-decision',
              'decision',
              'Use the smaller design with a migration path.',
            ),
          ]
        : [],
    plans: [],
    toolCalls: [],
    events: [],
    codeChanges: [
      {
        path: `src/step-${i}.ts`,
        capturedOnly: true,
        timestamp: stamp(i, 20),
        revisions: [
          {
            recordId: `parity-revision-${i}`,
            timestamp: stamp(i, 20),
            diff: `--- a/src/step-${i}.ts\n+++ b/src/step-${i}.ts\n@@ -1 +1 @@\n-const value${i} = "old${i}";\n+const value${i} = "new${i}";\n`,
          },
        ],
      },
    ],
    ...(i === 0
      ? {
          recap: event(
            i,
            'parity-recap-measured',
            'recap',
            'Implemented and verified the selected approach.',
            {
              durationMs: 12345,
              inputTokens: 1200,
              outputTokens: 300,
              cacheReadTokens: 40,
              cacheCreationTokens: 0,
              gitBranch: 'feature/readable-reports',
              timestamp: stamp(i, 45),
            },
          ),
        }
      : i === 1
        ? {
            recap: event(
              i,
              'parity-recap-zero',
              'recap',
              'Completed with captured zero usage.',
              {
                durationMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                gitBranch: 'feature/zero-usage',
                timestamp: stamp(i, 45),
              },
            ),
          }
        : {}),
  }));
  // A file can contain metadata-only snapshots before an exact persisted diff.
  turns[0]!.codeChanges[0]!.revisions!.unshift({
    recordId: 'parity-metadata-only-revision',
    timestamp: stamp(0, 19),
    sha256: 'a'.repeat(64),
  });
  const approvedLines = [
    '# Approved storage plan',
    '',
    '```typescript',
    'const wideCapturedLine = "Captured code stays exact and supports keyboard scrolling on phones.";',
    '```',
    '',
    '| Captured field | Recorded value |',
    '| --- | --- |',
    '| evidence | A complete retained value |',
    '',
  ];
  for (let i = 0; i < 22; i++)
    approvedLines.push(
      `## Step ${i}: Portable local history`,
      '',
      `- **Record ${i}:** keep \`capture${i}()\` and [the design note](https://example.com/design-${i}) available with complete evidence and an ordinary developer workflow.`,
      `- **Review ${i}:** preserve each revision, validate the stored result, and keep source context readable for the person reviewing this plan.`,
      '',
    );
  approvedLines.push(
    '## Completion',
    '',
    'All captured work stays available; the complete plan remains ordinary formatted prose.',
  );
  const approved = approvedLines.join('\n');
  const revised =
    '# Revised reading plan\n\nUse ordinary document scrolling and preserve the full plan.';
  const feedback = 'Keep document scrolling; remove the nested panes.';
  turns[0]!.plans.push(
    event(0, 'parity-plan-approved', 'plan', approved, {
      tags: ['plan-approved'],
      sourceId: 'native-plan-approved',
      planPath: 'plans/approved.md',
      timestamp: stamp(0, 10),
    }),
  );
  turns[1]!.plans.push(
    event(
      1,
      'parity-plan-revised',
      'plan',
      `**You sent this back asking:** ${feedback}\n\n---\n\n${revised}`,
      {
        tags: ['plan-revised'],
        sourceId: 'native-plan-revised',
        planPath: 'plans/revised.md',
        timestamp: stamp(1, 10),
      },
    ),
  );
  turns[0]!.toolCalls = Array.from({ length: 6 }, (_, i) =>
    event(
      0,
      `parity-tool-${i}`,
      'tool_call',
      JSON.stringify({
        command: i === 5 ? 'bun test failed-case' : `read-file-${i}`,
        stdout: `Captured output ${i}`,
        stderr: i === 5 ? 'Deliberate tool failure' : '',
        exitCode: i === 5 ? 7 : 0,
      }),
      {
        toolName: i < 3 ? 'Read' : 'Bash',
        sourceId: `native-call-${i}`,
        isError: i === 5,
        timestamp: stamp(0, 11 + i),
      },
    ),
  );
  turns[0]!.events = [
    {
      type: 'tool_result',
      sourceId: 'native-call-5:result',
      sequence: 1,
      toolUseId: 'native-call-5',
      stdout: 'Complete stdout',
      stderr: 'Deliberate tool failure',
      exitCode: 7,
      isError: true,
    },
  ];
  // Complete Markdown after the first text page checks state carried across chunks.
  turns[13]!.aiOutputs[0]!.text =
    'Lead-in paragraph.\n\n'.repeat(220) +
    '## Late Markdown heading\n\n**SHOWTAIL_LATE_SEARCH_MARKDOWN_CANARY**\n\n```js\n' +
    'const repeated = 1;\n'.repeat(230) +
    'const late = "FENCE_CONTINUITY_CANARY";\n```\n\nFinal paragraph.';
  return {
    schemaVersion: 3,
    displayName: 'Reading flow feature parity',
    project: null,
    generatedAt: stamp(15),
    scope: null,
    summary: {
      sessions: 3,
      events: 41,
      artifacts: 15,
      plans: 3,
      decisions: 1,
      stats: {
        totalDurationMs: 12345,
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalCacheReadTokens: 40,
        totalCacheCreationTokens: 0,
      },
    },
    contributors: [
      { slug: 'alice', name: 'Alice Example', events: 21, artifacts: 8 },
      { slug: 'bob', name: 'Bob Example', events: 20, artifacts: 7 },
    ],
    tools: [
      { tool: 'codex', events: 21 },
      { tool: 'claude', events: 20 },
    ],
    models: [
      { model: 'gpt-5.5', events: 7 },
      { model: 'claude-opus-4-8', events: 7 },
    ],
    toolTimeline: [
      { tool: 'codex', from: stamp(0), to: stamp(0, 45), count: 15 },
      { tool: 'claude', from: stamp(1), to: stamp(13), count: 26 },
    ],
    plans: [
      {
        text: approved,
        status: 'approved',
        planPath: 'plans/approved.md',
        timestamp: stamp(0, 10),
        tool: 'codex',
        actorSlug: 'alice',
      },
      {
        text: revised,
        status: 'revised',
        feedback,
        planPath: 'plans/revised.md',
        timestamp: stamp(1, 10),
        tool: 'claude',
        actorSlug: 'bob',
      },
      {
        text: '# Orphan migration plan\n\nA saved plan with no remaining linked exchange.',
        status: 'none',
        timestamp: stamp(14),
        tool: 'codex',
        actorSlug: 'alice',
      },
    ],
    turns,
    redactionCount: 3,
    authorship:
      'Captured evidence describes recorded work; it does not establish who authored every observed file change.',
    coverage: {
      status: 'partial',
      meaning: 'Some source history is unavailable; captured work is retained.',
      from: stamp(0),
      to: stamp(14),
      sources: [
        {
          sessionId: 'session-alpha',
          status: 'reconciled',
          prompts: 6,
          matched: 6,
          missing: 0,
          warningCodes: [],
        },
        {
          sessionId: 'session-bravo',
          status: 'partial',
          prompts: 5,
          matched: 4,
          missing: 1,
          warningCodes: ['source-unavailable'],
        },
      ],
    },
    fileObservations: [
      {
        recordId: 'parity-workspace-observation',
        path: 'src/manual.ts',
        basis: 'workspace-delta',
        observedAt: stamp(13, 30),
        toolOutcome: 'failed',
        toolCallId: 'parity-tool-5',
        diff: '--- a/src/manual.ts\n+++ b/src/manual.ts\n+manual or concurrent change\n',
      },
    ],
  };
}
