import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { logEvent, readAllEvents } from '../src/core/events.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { buildReportData, renderHtml, renderMarkdown } from '../src/core/report.ts';
import { turnTimeline } from '../src/core/report/data.ts';
import type { Event, ReportData, Turn } from '../src/types.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportClaudeCode } from '../src/commands/importClaude.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

/**
 * A transcript where Claude pauses with `AskUserQuestion` (two questions in one
 * call: the first answered by picking an option, the second by typing a custom
 * answer), then the student's answers come back as a `tool_result` line.
 */
function makeDecisionTranscript(): string {
  const lines: unknown[] = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-10T10:00:00.000Z',
      promptSource: 'typed',
      sessionId: 'sess-1',
      message: { role: 'user', content: 'Build authentication for the app.' },
    },
    {
      type: 'assistant',
      uuid: 'u2',
      timestamp: '2026-06-10T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'Let me confirm a couple of things first.' },
          {
            type: 'tool_use',
            id: 'tq1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which auth approach?',
                  header: 'Auth',
                  multiSelect: false,
                  options: [
                    { label: 'Session cookies', description: 'Server sessions.' },
                    { label: 'JWT', description: 'Stateless tokens.' },
                    { label: 'OAuth only', description: 'Delegate to a provider.' },
                  ],
                },
                {
                  question: 'What should the auth function be named?',
                  header: 'Name',
                  multiSelect: false,
                  options: [
                    { label: 'authenticate', description: 'Verb.' },
                    { label: 'login', description: 'Short.' },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-06-10T10:02:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tq1',
            content:
              'Your questions have been answered: "Which auth approach?"="JWT" ' +
              'selected preview:\nstateless tokens, ' +
              '"What should the auth function be named?"="verifyUser". ' +
              'You can now continue with these answers in mind.',
          },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseClaudeTranscript — decisions', () => {
  test('pairs an AskUserQuestion with its answer; marks chosen + typed', () => {
    const dir = makeTempDir();
    try {
      const { messages } = parseClaudeTranscript(makeDecisionTranscript(), dir);
      const decision = messages.find((m) => m.role === 'decision');
      expect(decision).toBeDefined();
      expect(decision!.sourceId).toBe('tq1');

      const text = decision!.text;
      // The question and all offered options are present.
      expect(text).toContain('Which auth approach?');
      expect(text).toContain('Session cookies');
      expect(text).toContain('OAuth only');
      // The picked option is marked; the others are not.
      expect(text).toContain('**JWT** ✅');
      expect(text).not.toContain('**Session cookies** ✅');
      // The second question was answered with free-typed text.
      expect(text).toContain('What should the auth function be named?');
      expect(text).toContain('**You typed:** verifyUser');

      // Structured data is resolved too.
      const q1 = decision!.questions![0]!;
      expect(q1.options.find((o) => o.label === 'JWT')!.chosen).toBe(true);
      expect(q1.custom).toBe(false);
      const q2 = decision!.questions![1]!;
      expect(q2.custom).toBe(true);
      expect(q2.answer).toBe('verifyUser');
    } finally {
      cleanup(dir);
    }
  });

  test('reads answers from the clarify/reject result format (preset, typed, none)', () => {
    const dir = makeTempDir();
    try {
      // An AskUserQuestion answered through the "clarify" flow: the result echoes
      // each question with `Answer: …` or `(No answer provided)`, not `"Q"="A"`.
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-10T10:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'sess-1',
          message: { role: 'user', content: 'Build it.' },
        },
        {
          type: 'assistant',
          uuid: 'u2',
          timestamp: '2026-06-10T10:01:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [
              {
                type: 'tool_use',
                id: 'tq1',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Which DB?',
                      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                    },
                    {
                      question: 'Name the function?',
                      options: [{ label: 'authenticate' }, { label: 'login' }],
                    },
                    {
                      question: 'Which port?',
                      options: [{ label: '3000' }, { label: '8080' }],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u3',
          timestamp: '2026-06-10T10:02:00.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tq1',
                content:
                  "The user doesn't want to proceed with this tool use. " +
                  'To tell you how to proceed, the user said:\n' +
                  'The user wants to clarify these questions.\n\n' +
                  '    Questions asked:\n' +
                  '- "Which DB?"\n  Answer: SQLite\n' +
                  '- "Name the function?"\n  Answer: makeWidget\n' +
                  '- "Which port?"\n  (No answer provided)',
              },
            ],
          },
        },
      ];
      const transcript = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { messages } = parseClaudeTranscript(transcript, dir);
      const d = messages.find((m) => m.role === 'decision')!;
      expect(d).toBeDefined();

      // Q1: preset option marked chosen.
      expect(d.questions![0]!.options.find((o) => o.label === 'SQLite')!.chosen).toBe(
        true,
      );
      expect(d.text).toContain('**SQLite** ✅');
      // Q2: custom typed answer surfaced.
      expect(d.questions![1]!.custom).toBe(true);
      expect(d.text).toContain('**You typed:** makeWidget');
      // Q3: unanswered → flagged, nothing marked.
      expect(d.questions![2]!.options.some((o) => o.chosen)).toBe(false);
      expect(d.text).toContain('_(no option selected)_');
    } finally {
      cleanup(dir);
    }
  });

  test('reads answers + notes from the structured toolUseResult', () => {
    const dir = makeTempDir();
    try {
      const q1 = 'Which DB?';
      const q2 = 'Pick features?';
      const q3 = 'Anything else?';
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-10T10:00:00.000Z',
          promptSource: 'typed',
          sessionId: 'sess-1',
          message: { role: 'user', content: 'Set it up.' },
        },
        {
          type: 'assistant',
          uuid: 'u2',
          timestamp: '2026-06-10T10:01:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [
              {
                type: 'tool_use',
                id: 'tq1',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: q1,
                      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                    },
                    {
                      question: q2,
                      multiSelect: true,
                      options: [
                        { label: 'Auth' },
                        { label: 'Logging' },
                        { label: 'Cache' },
                      ],
                    },
                    { question: q3, options: [{ label: 'Yes' }, { label: 'No' }] },
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u3',
          timestamp: '2026-06-10T10:02:00.000Z',
          // The structured result lives at the line level, alongside `message`.
          toolUseResult: {
            answers: {
              [q1]: 'SQLite',
              [q2]: 'Auth, Cache',
              [q3]: '(notes only)',
            },
            annotations: {
              [q1]: { notes: 'use the lightweight one' },
              [q3]: { notes: 'please add docs' },
            },
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tq1',
                content: 'Your questions have been answered: (see structured result).',
              },
            ],
          },
        },
      ];
      const transcript = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { messages } = parseClaudeTranscript(transcript, dir);
      const d = messages.find((m) => m.role === 'decision')!;
      expect(d).toBeDefined();

      // Q1: preset chosen + note rendered.
      expect(d.questions![0]!.options.find((o) => o.label === 'SQLite')!.chosen).toBe(
        true,
      );
      expect(d.text).toContain('**SQLite** ✅');
      expect(d.text).toContain('**Your note:** use the lightweight one');
      // Q2: multi-select marks every chosen label.
      const f = d.questions![1]!.options;
      expect(f.find((o) => o.label === 'Auth')!.chosen).toBe(true);
      expect(f.find((o) => o.label === 'Cache')!.chosen).toBe(true);
      expect(f.find((o) => o.label === 'Logging')!.chosen).toBe(false);
      // Q3: notes-only → no option, but the note is captured.
      expect(d.questions![2]!.options.some((o) => o.chosen)).toBe(false);
      expect(d.text).toContain('_(no option selected)_');
      expect(d.text).toContain('**Your note:** please add docs');
    } finally {
      cleanup(dir);
    }
  });
});

describe('claude-code decision import', () => {
  test('imports decisions as decision events (even without responses) and dedupes', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeDecisionTranscript(), 'utf8');

      // No --with-responses: decisions are the student's own work, so they still import.
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });

      const cc = () => readAllEvents(paths).filter((e) => e.tool === 'claude-code');
      const decisions = cc().filter((e) => e.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(cc().filter((e) => e.type === 'ai_output').length).toBe(0);
      expect(decisions[0]!.text).toContain('**JWT** ✅');
      expect(decisions[0]!.tags).toContain('imported');
      expect(decisions[0]!.turnId).toBeDefined(); // attached to the prompt's turn

      // Re-importing the same transcript adds nothing (deduped by sourceId).
      const before = cc().length;
      await runImportClaudeCode(undefined, { file: fixture, cwd: dir });
      expect(cc().length).toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  test('the report shows the decision inline and counts it in the summary', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'transcript.jsonl');
      writeFileSync(fixture, makeDecisionTranscript(), 'utf8');
      await runImportClaudeCode(undefined, {
        file: fixture,
        withResponses: true,
        cwd: dir,
      });

      const data = buildReportData(paths);
      expect(data.summary.decisions).toBe(1);
      // The decision attached to its exchange.
      const turnWithDecision = data.turns.find((t) => t.decisions.length > 0);
      expect(turnWithDecision).toBeDefined();

      const md = renderMarkdown(data);
      expect(md).toContain('🔀 **Decision**');
      expect(md).toContain('**JWT** ✅');
      expect(md).toContain('1 decision(s)'); // summary line

      // The collapsed HTML card surfaces the decision count in its stat (under the
      // date), so a reviewer sees a decision happened without expanding the card.
      const html = renderHtml(data);
      const stat = /<span class="stat">([^<]*)<\/span>/.exec(html)?.[1] ?? '';
      expect(stat).toContain('1 decision(s)');
    } finally {
      cleanup(dir);
    }
  });

  test('a turn with both an edit and a decision shows both in the card stat', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      // A real file to snapshot — live capture records edits as file snapshots.
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const db = "sqlite";\n', 'utf8');

      // One exchange (as live capture builds it): a prompt, then a file snapshot
      // AND a decision, both linked to that prompt's turn.
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'Set up the database.',
        tool: 'claude-code',
      });
      await addArtifact(author, {
        filePath: join(dir, 'src', 'app.ts'),
        tool: 'claude-code',
        turnId: prompt.id,
      });
      await logEvent(author, {
        type: 'decision',
        text: '**Claude asked:** Which DB?\n\n- **SQLite** ✅ _(your choice)_\n- Postgres',
        tool: 'claude-code',
        turnId: prompt.id,
      });

      const data = buildReportData(paths);
      const turn = data.turns.find(
        (t) => t.codeChanges.length > 0 && t.decisions.length > 0,
      );
      expect(turn).toBeDefined(); // the edit and the decision share one turn

      const html = renderHtml(data);
      const stat = /<span class="stat">([^<]*)<\/span>/.exec(html)?.[1] ?? '';
      // Both counts appear on the one stat line, joined — no conflict.
      expect(stat).toContain('1 file(s)');
      expect(stat).toContain('1 decision(s)');
      expect(stat).toContain(' · ');
    } finally {
      cleanup(dir);
    }
  });
});

describe('turn timeline (chronological interleaving)', () => {
  const ev = (id: string, ts: string, type: Event['type'], text: string): Event => ({
    id,
    timestamp: ts,
    type,
    text,
    tool: 'claude-code',
    actorSlug: 'x',
  });

  // A turn whose items happened in the order: reply, edit, reply, edit, decision.
  const interleavedTurn = (): Turn => ({
    prompt: ev('p', '2026-01-01T00:00:00.000Z', 'prompt', 'do it'),
    aiOutputs: [
      ev('a1', '2026-01-01T00:00:01.000Z', 'ai_output', 'first reply'),
      ev('a2', '2026-01-01T00:00:03.000Z', 'ai_output', 'second reply'),
    ],
    codeChanges: [
      { path: 'first.ts', timestamp: '2026-01-01T00:00:02.000Z', diff: '+one' },
      { path: 'second.ts', timestamp: '2026-01-01T00:00:04.000Z', diff: '+two' },
    ],
    decisions: [
      ev('d', '2026-01-01T00:00:05.000Z', 'decision', '**Claude asked:** which?'),
    ],
    plans: [],
    tool: 'claude-code',
    actorSlug: 'x',
    sessionId: 'sess',
  });

  test('merges replies, code, and decisions in timestamp order', () => {
    const order = turnTimeline(interleavedTurn()).map((i) =>
      i.kind === 'code' ? `code:${i.change.path}` : `${i.kind}:${i.event.id}`,
    );
    expect(order).toEqual([
      'ai:a1',
      'code:first.ts',
      'ai:a2',
      'code:second.ts',
      'decision:d',
    ]);
  });

  test('keeps text before tools that share its timestamp', () => {
    const t = '2026-01-01T00:00:01.000Z';
    const turn: Turn = {
      prompt: ev('p', '2026-01-01T00:00:00.000Z', 'prompt', 'do it'),
      aiOutputs: [ev('a', t, 'ai_output', 'reply')],
      codeChanges: [{ path: 'x.ts', timestamp: t, diff: '+x' }],
      decisions: [ev('d', t, 'decision', 'q')],
      plans: [],
      tool: 'claude-code',
      actorSlug: 'x',
      sessionId: 'sess',
    };
    expect(turnTimeline(turn).map((i) => i.kind)).toEqual(['ai', 'code', 'decision']);
  });

  test('renders code and decisions inline in order, with AI replies in the collapsed group', () => {
    // Uniform rule: the student's work (code, decisions) reads inline in timestamp
    // order; every AI reply is subordinated to the one collapsed group, regardless
    // of where it fell in time.
    const turn: Turn = {
      prompt: ev('p', '2026-01-01T00:00:00.000Z', 'prompt', 'do it'),
      aiOutputs: [
        ev('a1', '2026-01-01T00:00:02.000Z', 'ai_output', 'first reply'),
        ev('a2', '2026-01-01T00:00:04.000Z', 'ai_output', 'second reply'),
      ],
      codeChanges: [
        { path: 'first.ts', timestamp: '2026-01-01T00:00:02.000Z', diff: '+one' },
        { path: 'second.ts', timestamp: '2026-01-01T00:00:04.000Z', diff: '+two' },
      ],
      decisions: [
        ev('d', '2026-01-01T00:00:05.000Z', 'decision', '**Claude asked:** which?'),
      ],
      plans: [],
      tool: 'claude-code',
      actorSlug: 'x',
      sessionId: 'sess',
    };
    const data: ReportData = {
      project: 'P',
      displayName: 'P',
      generatedAt: '2026-01-01T00:00:06.000Z',
      scope: null,
      summary: { sessions: 1, events: 3, artifacts: 2, decisions: 1, plans: 0 },
      contributors: [{ slug: 'x', name: 'X', events: 3, artifacts: 2 }],
      tools: [{ tool: 'claude-code', events: 3 }],
      models: [],
      toolTimeline: [],
      turns: [turn],
      plans: [],
      redactionCount: 0,
      authorship: 'mine',
    };
    const md = renderMarkdown(data);
    const at = (s: string) => md.indexOf(s);
    // Work reads inline in order: first.ts → second.ts → decision.
    expect(at('first.ts')).toBeLessThan(at('second.ts'));
    expect(at('second.ts')).toBeLessThan(at('🔀 **Decision**'));
    // Both AI replies are folded into the one collapsed group after the work.
    expect(md).toContain('<details><summary>🤖 2 AI message(s)</summary>');
    expect(at('🔀 **Decision**')).toBeLessThan(at('first reply'));
    expect(at('first reply')).toBeLessThan(at('second reply'));
  });

  test('a worktree code change links from linkPath but shows the clean path', () => {
    const data: ReportData = {
      project: 'P',
      displayName: 'P',
      generatedAt: '2026-01-01T00:00:06.000Z',
      scope: null,
      summary: { sessions: 1, events: 1, artifacts: 1, decisions: 0, plans: 0 },
      contributors: [{ slug: 'x', name: 'X', events: 1, artifacts: 1 }],
      tools: [{ tool: 'claude-code', events: 1 }],
      models: [],
      toolTimeline: [],
      turns: [
        {
          prompt: ev('p', '2026-01-01T00:00:00.000Z', 'prompt', 'do it'),
          aiOutputs: [],
          codeChanges: [
            {
              path: 'src/foo.ts',
              linkPath: '.claude/worktrees/wt/src/foo.ts',
              diff: '+x',
              timestamp: '2026-01-01T00:00:01.000Z',
            },
          ],
          decisions: [],
          plans: [],
          tool: 'claude-code',
          actorSlug: 'x',
          sessionId: 'sess',
        },
      ],
      plans: [],
      redactionCount: 0,
      authorship: 'mine',
    };
    // Link resolves from the full link path; the label stays the clean path.
    expect(renderMarkdown(data)).toContain(
      '[`src/foo.ts`](../../.claude/worktrees/wt/src/foo.ts)',
    );
    const html = renderHtml(data);
    expect(html).toContain('href="../../.claude/worktrees/wt/src/foo.ts"');
    expect(html).toContain('>src/foo.ts</a>');
  });
});
