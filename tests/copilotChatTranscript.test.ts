import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extractCopilotEdits,
  parseShowtailProjectControlMarker,
  parseCopilotSession,
  parseCopilotChatTranscript,
  reconstructSession,
} from '../src/core/copilotChatTranscript.ts';
import { enableToolCapture, writeGlobalConfig } from '../src/core/globalConfig.ts';
import { renderHtml } from '../src/core/report.ts';
import { cleanup, makeTempDir } from './helpers.ts';
const ms = (iso: string): number => Date.parse(iso);
/** A `manage_todo_list` response part — Copilot's plan (a status checklist). */
const TODO_PART = {
  kind: 'toolInvocationSerialized',
  toolId: 'manage_todo_list',
  toolSpecificData: {
    kind: 'todoList',
    todoList: [
      { id: '1', title: 'Add the foo function', status: 'completed' },
      { id: '2', title: 'Add a test', status: 'not-started' },
    ],
  },
};
/**
 * A `request.result` carrying a `vscode_askQuestions` decision (in toolCallRounds)
 * and its answer (in toolCallResults) — Copilot's AskUserQuestion. Keeps a
 * `response` so it still works as the reply fallback when no markdown is present.
 */
const ASK_RESULT = {
  metadata: {
    toolCallRounds: [
      {
        response: 'fallback (unused)',
        toolCalls: [
          {
            id: 'call_dec1',
            name: 'vscode_askQuestions',
            arguments: JSON.stringify({
              questions: [
                {
                  header: 'feature',
                  question: 'Which feature should I add?',
                  multiSelect: false,
                  options: [
                    { label: 'Quiz mode', description: 'guess the language' },
                    { label: 'Menu mode', description: 'pick a category' },
                  ],
                },
              ],
            }),
          },
        ],
      },
    ],
    toolCallResults: {
      call_dec1: {
        content: [
          {
            value: JSON.stringify({
              answers: {
                feature: { selected: ['Quiz mode'], freeText: null, skipped: false },
              },
            }),
          },
        ],
      },
    },
  },
};
/**
 * Build a synthetic native Copilot Chat session for `dir` (the project folder),
 * mixing the shapes we keep — a typed prompt (`message.text`), a streamed reply
 * (markdown `response[]` parts with no `kind`), and `textEditGroup` edits — with
 * the noise we must drop: a `thinking` part (internal reasoning), an edit to an
 * internal `.vscode` file, and a whole request answered by our own `@showtail`
 * participant (captured live, never re-imported from the file).
 */
function makeSession(dir: string): string {
  const doc = {
    version: 3,
    sessionId: 'sess-copilot-1',
    requesterUsername: 'me',
    requests: [
      {
        requestId: 'request_1',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: 'Add a foo function.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [
          { value: "I'll add the foo function. " },
          { kind: 'thinking', value: 'INTERNAL REASONING — must be dropped' },
          TODO_PART,
          {
            kind: 'textEditGroup',
            uri: { fsPath: join(dir, 'src', 'foo.ts') },
            edits: [[{ text: 'export const foo = () => {};', range: {} }]],
          },
          {
            // An edit to an internal .vscode file — dropped.
            kind: 'textEditGroup',
            uri: { fsPath: join(dir, '.vscode', 'settings.json') },
            edits: [[{ text: '{}', range: {} }]],
          },
        ],
        result: ASK_RESULT,
      },
      {
        // Our own @showtail participant — must be skipped entirely.
        requestId: 'request_2',
        timestamp: ms('2026-06-22T10:00:30.000Z'),
        message: { text: '@showtail report' },
        agent: { extensionId: { value: 'Tingsters.showtail' } },
        response: [{ value: 'a showtail reply that must not be imported' }],
      },
      {
        requestId: 'request_3',
        timestamp: ms('2026-06-22T10:01:00.000Z'),
        message: { text: 'Now add a test.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [{ value: 'Sure — adding a test now.' }],
      },
    ],
  };
  return JSON.stringify(doc);
}
/**
 * The SAME session as {@link makeSession}, but in the current VS Code `.jsonl`
 * **patch-journal** form: a `kind:0` empty snapshot, a `kind:1` set, `kind:2`
 * appends that add each request to `requests[]`, and a nested `kind:2` append that
 * streams request_3's reply into `requests[2].response`. Replaying it must rebuild
 * the identical session, proving {@link reconstructSession}.
 */
function makeJournal(dir: string): string {
  const r1 = {
    requestId: 'request_1',
    timestamp: ms('2026-06-22T10:00:00.000Z'),
    message: { text: 'Add a foo function.' },
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
    response: [
      { value: "I'll add the foo function. " },
      { kind: 'thinking', value: 'INTERNAL REASONING — must be dropped' },
      TODO_PART,
      {
        kind: 'textEditGroup',
        uri: { fsPath: join(dir, 'src', 'foo.ts') },
        edits: [[{ text: 'export const foo = () => {};', range: {} }]],
      },
      {
        kind: 'textEditGroup',
        uri: { fsPath: join(dir, '.vscode', 'settings.json') },
        edits: [[{ text: '{}', range: {} }]],
      },
    ],
    result: ASK_RESULT,
  };
  const r2 = {
    requestId: 'request_2',
    timestamp: ms('2026-06-22T10:00:30.000Z'),
    message: { text: '@showtail report' },
    agent: { extensionId: { value: 'Tingsters.showtail' } },
    response: [{ value: 'a showtail reply that must not be imported' }],
  };
  const r3 = {
    requestId: 'request_3',
    timestamp: ms('2026-06-22T10:01:00.000Z'),
    message: { text: 'Now add a test.' },
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
    response: [], // streamed in below via a nested kind:2 append
  };
  const lines: unknown[] = [
    { kind: 0, v: { version: 3, sessionId: 'sess-copilot-1', requests: [] } },
    { kind: 1, k: ['responderUsername'], v: 'GitHub Copilot' },
    { kind: 2, k: ['requests'], v: [r1] },
    { kind: 2, k: ['requests'], v: [r2] },
    { kind: 2, k: ['requests'], v: [r3] },
    {
      kind: 2,
      k: ['requests', 2, 'response'],
      v: [{ value: 'Sure — adding a test now.' }],
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
/** A compact native session for routing tests, with arbitrary edited paths. */
function makeRoutingSession(
  editPaths: string[],
  options: {
    prompt?: string;
    sessionId?: string;
  } = {},
): string {
  const prompt = options.prompt ?? 'Build both files.';
  const response = [
    ...(prompt ? [{ value: 'Done.' }] : []),
    ...editPaths.map((fsPath, index) => ({
      kind: 'textEditGroup',
      uri: { fsPath },
      edits: [[{ text: `export const value${index} = ${index};`, range: {} }]],
    })),
  ];
  return JSON.stringify({
    version: 3,
    sessionId: options.sessionId ?? 'routing-session',
    requests: [
      {
        requestId: 'routing-request',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: prompt },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response,
      },
    ],
  });
}
/** One native chat whose second turn happens after the project folder moved. */
function makeMovedContinuationSession(oldFile: string, newFile?: string): string {
  const request = (
    requestId: string,
    prompt: string,
    fsPath: string,
    text: string,
    timestamp: string,
  ) => ({
    requestId,
    timestamp: ms(timestamp),
    message: { text: prompt },
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
    response: [
      { value: 'Done.' },
      {
        kind: 'textEditGroup',
        uri: { fsPath },
        edits: [[{ text, range: {} }]],
      },
    ],
  });
  return JSON.stringify({
    version: 3,
    sessionId: 'moved-continuation',
    requests: [
      request(
        'before-move',
        'Build the first screen.',
        oldFile,
        'export const first = 1;',
        '2026-06-22T10:00:00.000Z',
      ),
      ...(newFile
        ? [
            request(
              'after-move',
              'Add the second screen.',
              newFile,
              'export const second = 2;',
              '2026-06-22T10:02:00.000Z',
            ),
          ]
        : []),
    ],
  });
}
/** Keep the fixed transcript dates inside the watcher capture window. */
function setAutomaticImportTracking(enabled: boolean): void {
  writeGlobalConfig({
    version: 1,
    captureEnabled: enabled,
    captureSince: '2026-06-01T00:00:00.000Z',
  });
}
describe('parseCopilotChatTranscript', () => {
  test('keeps prompts, replies and repo edits; drops thinking, internal edits, @showtail', () => {
    const dir = makeTempDir();
    try {
      const parsed = parseCopilotChatTranscript(makeSession(dir), dir);
      expect(parsed.sessionId).toBe('sess-copilot-1');
      const roles = parsed.messages.map((m) => m.role);
      expect(roles.filter((r) => r === 'user').length).toBe(2); // request_1 + request_3
      expect(roles.filter((r) => r === 'assistant').length).toBe(2);
      expect(roles.filter((r) => r === 'edit').length).toBe(1);
      const blob = parsed.messages.map((m) => m.text).join('\n');
      expect(blob).not.toContain('INTERNAL REASONING');
      expect(blob).not.toContain('settings.json');
      expect(blob).not.toContain('showtail reply');
      expect(blob).not.toContain('@showtail report');
      // The reply comes from the markdown part, not the metadata fallback.
      const reply = parsed.messages.find((m) => m.role === 'assistant')!;
      expect(reply.text).toContain("I'll add the foo function");
      expect(reply.text).not.toContain('fallback');
      // The edit: absolute fsPath → repo-relative; inserted text → `+ ` diff lines.
      const edit = parsed.messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['src/foo.ts']);
      expect(edit.edits).toHaveLength(1);
      expect(edit.edits![0]!.file).toBe('src/foo.ts');
      expect(edit.edits![0]!.diff).toContain('+ export const foo = () => {};');
      // Stable, request-keyed source ids (so the live watcher + import dedupe).
      expect(parsed.messages[0]!.sourceId).toBe('copilot:user:sess-copilot-1:request_1');
      // epoch-ms timestamp → ISO, preserved for back-dating.
      expect(parsed.messages[0]!.timestamp).toBe('2026-06-22T10:00:00.000Z');
    } finally {
      cleanup(dir);
    }
  });
  test('preserves visible inline references and marks only completed replies final', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'fairy_sparkle.py');
      const parsed = parseCopilotSession(
        {
          sessionId: 'inline-references',
          requests: [
            {
              requestId: 'partial-request',
              timestamp: ms('2026-09-10T10:00:00.000Z'),
              message: { text: 'Where is the game?' },
              response: [
                { value: 'The game is located at: ' },
                { kind: 'inlineReference', inlineReference: { fsPath: file } },
                { kind: 'thinking', value: 'hidden reasoning' },
              ],
            },
            {
              requestId: 'final-request',
              timestamp: ms('2026-09-10T10:01:00.000Z'),
              message: { text: 'Which symbol starts it?' },
              response: [
                { value: 'Run ' },
                {
                  kind: 'inlineReference',
                  inlineReference: { name: 'render`Game', fsPath: file },
                },
                { kind: 'toolInvocationSerialized', value: 'hidden tool output' },
              ],
              result: {},
            },
          ],
        },
        dir,
      );
      const replies = parsed.messages.filter((message) => message.role === 'assistant');
      expect(replies[0]).toMatchObject({
        text: `The game is located at: \`${file}\``,
        isFinal: false,
      });
      expect(replies[1]?.text).toContain('render`Game');
      expect(replies[1]?.isFinal).toBe(true);
      expect(replies.map((reply) => reply.text).join('\n')).not.toContain('hidden');
    } finally {
      cleanup(dir);
    }
  });
  test('keeps only explicit request attachments and a marker from the exact control tool result', () => {
    const attachedProject = makeTempDir();
    const selectedProject = makeTempDir();
    try {
      const attachedFile = join(attachedProject, 'game.ts');
      const attachedFolder = join(attachedProject, 'levels');
      const marker = {
        showtailProjectControl: 'showtail-project-control/v1',
        claimId: '123e4567-e89b-42d3-a456-426614174010',
        action: 'report',
        trailId: 'trl_selected',
        root: selectedProject,
        displayName: 'Selected game',
        mode: 'corroborated',
        evidence: ['complete-name', 'edit-focus'],
        crossWorkspace: true,
        reportPath: join(selectedProject, '.showtail', 'reports', 'report.html'),
      };
      const session = {
        sessionId: 'routing-metadata',
        requests: [
          {
            requestId: 'request-routing',
            timestamp: ms('2026-09-10T10:00:00.000Z'),
            message: { text: 'report my game' },
            agent: { extensionId: { value: 'GitHub.copilot-chat' } },
            variableData: {
              variables: [
                { kind: 'file', id: 'file:///game.ts', value: { fsPath: attachedFile } },
                {
                  kind: 'folder',
                  id: 'file:///levels',
                  value: { uri: { fsPath: attachedFolder } },
                },
                {
                  kind: 'file',
                  id: 'vscode.implicit.selection',
                  value: { uri: { fsPath: join(selectedProject, 'active.ts') } },
                },
                {
                  kind: 'file',
                  id: 'automatic-file',
                  automaticallyAdded: true,
                  value: { fsPath: join(selectedProject, 'auto.ts') },
                },
                {
                  kind: 'promptFile',
                  id: 'instructions',
                  value: { fsPath: join(selectedProject, 'AGENTS.md') },
                },
              ],
            },
            response: [{ value: 'Report generated.' }],
            result: {
              metadata: {
                toolCallRounds: [
                  {
                    toolCalls: [
                      {
                        id: 'call-project',
                        name: 'showtail_project_control',
                        arguments: JSON.stringify({
                          action: 'report',
                          selector: 'my game',
                        }),
                      },
                    ],
                  },
                ],
                toolCallResults: {
                  'call-project': { content: [{ value: JSON.stringify(marker) }] },
                },
              },
            },
          },
        ],
      };
      const parsed = parseCopilotSession(session, attachedProject);
      const prompt = parsed.messages.find((message) => message.role === 'user')!;
      expect(prompt.requestId).toBe('request-routing');
      expect(prompt.attachments).toEqual([
        { kind: 'file', path: attachedFile },
        { kind: 'folder', path: attachedFolder },
      ]);
      expect(prompt.projectControl).toEqual(
        expect.objectContaining({
          claimId: marker.claimId,
          action: 'report',
          trailId: 'trl_selected',
          root: selectedProject,
          reportPath: marker.reportPath,
        }),
      );
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_use' && event.toolName === 'showtail_project_control',
        ),
      ).toBe(false);
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_result' &&
            JSON.stringify(event.content).includes(marker.claimId),
        ),
      ).toBe(false);
    } finally {
      cleanup(attachedProject);
      cleanup(selectedProject);
    }
  });
  test('rejects marker lookalikes, malformed fields, and action mismatches', () => {
    const root = makeTempDir();
    try {
      const valid = {
        showtailProjectControl: 'showtail-project-control/v1',
        claimId: '123e4567-e89b-42d3-a456-426614174011',
        action: 'verify',
        trailId: 'trl_selected',
        root,
        mode: 'authoritative',
        evidence: ['explicit-picker'],
      };
      expect(parseShowtailProjectControlMarker(JSON.stringify(valid))).toEqual(
        expect.objectContaining({ action: 'verify', trailId: 'trl_selected', root }),
      );
      expect(
        parseShowtailProjectControlMarker(
          JSON.stringify({ ...valid, claimId: 'not-a-uuid' }),
        ),
      ).toBeNull();
      expect(
        parseShowtailProjectControlMarker(JSON.stringify({ ...valid, root: 'relative' })),
      ).toBeNull();
      expect(
        parseShowtailProjectControlMarker(
          JSON.stringify({
            ...valid,
            showtailProjectControl: 'showtail-project-control/v2',
          }),
        ),
      ).toBeNull();
      const request = (
        name: string,
        argumentsAction: string,
        response: unknown[] = [{ value: JSON.stringify(valid) }],
      ) => ({
        requestId: 'request-lookalike',
        timestamp: ms('2026-09-10T10:00:00.000Z'),
        message: { text: 'verify it' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response,
        result: {
          metadata: {
            toolCallRounds: [
              {
                toolCalls: [
                  {
                    id: 'call-project',
                    name,
                    arguments: JSON.stringify({ action: argumentsAction }),
                  },
                ],
              },
            ],
            toolCallResults: {
              'call-project': { content: [{ value: JSON.stringify(valid) }] },
            },
          },
        },
      });
      expect(
        parseCopilotSession(
          { sessionId: 'wrong-tool', requests: [request('run_in_terminal', 'verify')] },
          root,
        ).messages.find((message) => message.role === 'user')?.projectControl,
      ).toBeUndefined();
      expect(
        parseCopilotSession(
          {
            sessionId: 'wrong-action',
            requests: [request('showtail_project_control', 'report')],
          },
          root,
        ).messages.find((message) => message.role === 'user')?.projectControl,
      ).toBeUndefined();
      expect(
        parseCopilotSession(
          {
            sessionId: 'assistant-lookalike',
            requests: [
              {
                requestId: 'request-text',
                timestamp: ms('2026-09-10T10:00:00.000Z'),
                message: { text: 'verify it' },
                agent: { extensionId: { value: 'GitHub.copilot-chat' } },
                response: [{ value: JSON.stringify(valid) }],
              },
            ],
          },
          root,
        ).messages.find((message) => message.role === 'user')?.projectControl,
      ).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });
  test('automatic recovery filters each request by its base timestamp', () => {
    const dir = makeTempDir();
    try {
      const session = reconstructSession(makeSession(dir));
      // This lands inside request_1's synthetic child offsets. The whole request
      // must stay excluded; only the later request_3 is eligible.
      const automaticCaptureSince = '2026-06-22T10:00:00.002Z';
      const parsed = parseCopilotSession(session, dir, { automaticCaptureSince });
      expect(parsed.messages.map((message) => message.sourceId)).toEqual([
        'copilot:user:sess-copilot-1:request_3',
        'copilot:asst:sess-copilot-1:request_3',
      ]);
      expect(parsed.events.map((event) => event.sourceId)).toEqual([
        'copilot:user:sess-copilot-1:request_3',
        'copilot:asst:sess-copilot-1:request_3',
      ]);
      expect(
        extractCopilotEdits(session, 'sess-copilot-1', { automaticCaptureSince }),
      ).toHaveLength(0);
      // The boundary is inclusive at the request level.
      expect(
        parseCopilotSession(session, dir, {
          automaticCaptureSince: '2026-06-22T10:01:00.000Z',
        }).messages.map((message) => message.sourceId),
      ).toEqual([
        'copilot:user:sess-copilot-1:request_3',
        'copilot:asst:sess-copilot-1:request_3',
      ]);
    } finally {
      cleanup(dir);
    }
  });
  test('automatic recovery fails closed for missing or invalid request timestamps', () => {
    const dir = makeTempDir();
    try {
      const request = (requestId: string, timestamp?: unknown) => ({
        requestId,
        ...(timestamp === undefined ? {} : { timestamp }),
        message: { text: requestId },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [
          { value: 'reply' },
          {
            kind: 'textEditGroup',
            uri: { fsPath: join(dir, `${requestId}.ts`) },
            edits: [[{ text: 'export {};', range: {} }]],
          },
        ],
      });
      const session = {
        sessionId: 'invalid-timestamps',
        requests: [
          request('missing'),
          request('string', 'not-a-date'),
          request('nan', NaN),
        ],
      };
      const options = { automaticCaptureSince: '2026-06-22T10:00:00.000Z' };
      expect(parseCopilotSession(session, dir, options).messages).toHaveLength(0);
      expect(extractCopilotEdits(session, 'invalid-timestamps', options)).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
  test('falls back to result.metadata.toolCallRounds when no markdown parts', () => {
    const dir = makeTempDir();
    try {
      const doc = {
        sessionId: 's',
        requests: [
          {
            requestId: 'r1',
            timestamp: ms('2026-06-22T10:00:00.000Z'),
            message: { text: 'hi' },
            agent: { extensionId: { value: 'GitHub.copilot-chat' } },
            response: [
              { kind: 'textEditGroup', uri: { fsPath: join(dir, 'a.txt') }, edits: [[]] },
            ],
            result: {
              metadata: { toolCallRounds: [{ response: 'the only reply text' }] },
            },
          },
        ],
      };
      const parsed = parseCopilotChatTranscript(JSON.stringify(doc), dir);
      const reply = parsed.messages.find((m) => m.role === 'assistant');
      expect(reply?.text).toBe('the only reply text');
    } finally {
      cleanup(dir);
    }
  });
  test('malformed JSON yields an empty transcript, never throws', () => {
    expect(parseCopilotChatTranscript('not json{', '/tmp/x').messages).toHaveLength(0);
  });
  test('captures the manage_todo_list plan and the vscode_askQuestions decision', () => {
    const dir = makeTempDir();
    try {
      const parsed = parseCopilotChatTranscript(makeSession(dir), dir);
      // Plan: the todo list renders as a Codex-style status checklist.
      const plan = parsed.messages.find((m) => m.role === 'plan')!;
      expect(plan).toBeDefined();
      expect(plan.sourceId).toBe('copilot:plan:sess-copilot-1:request_1');
      expect(plan.text).toContain('[x] Add the foo function');
      expect(plan.text).toContain('[ ] Add a test');
      // Decision: rendered like Claude/Codex, with the chosen option marked.
      const decision = parsed.messages.find((m) => m.role === 'decision')!;
      expect(decision).toBeDefined();
      expect(decision.sourceId).toBe('copilot:decision:sess-copilot-1:call_dec1');
      expect(decision.text).toContain('**Copilot asked:** Which feature should I add?');
      expect(decision.text).toContain('**Quiz mode** ✅ _(your choice)_');
      expect(decision.text).toContain('- Menu mode');
    } finally {
      cleanup(dir);
    }
  });
  test('replays the .jsonl patch journal (kind 0/1/2) into the same session', () => {
    const dir = makeTempDir();
    try {
      const parsed = parseCopilotChatTranscript(makeJournal(dir), dir);
      expect(parsed.sessionId).toBe('sess-copilot-1');
      const roles = parsed.messages.map((m) => m.role);
      expect(roles.filter((r) => r === 'user').length).toBe(2);
      expect(roles.filter((r) => r === 'assistant').length).toBe(2);
      expect(roles.filter((r) => r === 'edit').length).toBe(1);
      // @showtail turn dropped; thinking + internal edit dropped.
      const blob = parsed.messages.map((m) => m.text).join('\n');
      expect(blob).not.toContain('INTERNAL REASONING');
      expect(blob).not.toContain('settings.json');
      expect(blob).not.toContain('showtail reply');
      // request_3's reply was streamed in via a nested kind:2 append — replay must
      // have applied it to requests[2].response.
      const replies = parsed.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.text);
      expect(replies.some((t) => t.includes('Sure — adding a test now.'))).toBe(true);
      const edit = parsed.messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['src/foo.ts']);
      expect(edit.edits![0]!.diff).toContain('+ export const foo = () => {};');
      // Plans + decisions survive the journal replay too.
      expect(parsed.messages.find((m) => m.role === 'plan')?.text).toContain(
        '[x] Add the foo function',
      );
      expect(parsed.messages.find((m) => m.role === 'decision')?.text).toContain(
        '**Copilot asked:**',
      );
    } finally {
      cleanup(dir);
    }
  });
  test('rejects unsupported legacy session versions and schemas', () => {
    const dir = makeTempDir();
    try {
      const request = {
        requestId: 'request_unsupported',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: 'This must not become evidence.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [{ value: 'Nor should this reply.' }],
      };
      const documents = [
        { version: 999, sessionId: 'unknown-version', requests: [request] },
        { schemaVersion: 1, sessionId: 'unknown-schema', requests: [request] },
      ];
      for (const document of documents) {
        const content = JSON.stringify(document);
        expect(reconstructSession(content)).toEqual({});
        expect(parseCopilotChatTranscript(content, dir).messages).toHaveLength(0);
      }
    } finally {
      cleanup(dir);
    }
  });
  test('rejects unsupported journal snapshots before replaying later requests', () => {
    const dir = makeTempDir();
    try {
      const request = {
        requestId: 'request_unsupported',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: 'This must not become evidence.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [{ value: 'Nor should this reply.' }],
      };
      const journals = [
        [
          { kind: 0, v: { version: 999, sessionId: 'unknown-version', requests: [] } },
          { kind: 2, k: ['requests'], v: [request] },
        ],
        [
          { kind: 0, v: { schemaVersion: 1, sessionId: 'unknown-schema', requests: [] } },
          { kind: 2, k: ['requests'], v: [request] },
        ],
      ];
      for (const journal of journals) {
        const content = journal.map((line) => JSON.stringify(line)).join('\n');
        expect(reconstructSession(content)).toEqual({});
        expect(parseCopilotChatTranscript(content, dir).messages).toHaveLength(0);
      }
    } finally {
      cleanup(dir);
    }
  });
  test('rejects unknown and malformed journal deltas instead of partially replaying them', () => {
    const dir = makeTempDir();
    try {
      const request = {
        requestId: 'request_invalid_delta',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: 'This must not become evidence.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [{ value: 'Nor should this reply.' }],
      };
      const snapshot = {
        kind: 0,
        v: { version: 3, sessionId: 'invalid-journal', requests: [] },
      };
      const invalidDeltas = [
        { kind: 9, k: ['requests'], v: [request] },
        { kind: 2, k: 'requests', v: [request] },
        { kind: 2, k: ['requests'], v: request },
        { kind: 1, k: ['missing', 'request'], v: request },
        { kind: 1, k: ['__proto__', 'showtailPolluted'], v: true },
      ];
      for (const delta of invalidDeltas) {
        const content = [snapshot, delta].map((line) => JSON.stringify(line)).join('\n');
        expect(reconstructSession(content)).toEqual({});
        expect(parseCopilotChatTranscript(content, dir).messages).toHaveLength(0);
      }
      expect(Object.prototype).not.toHaveProperty('showtailPolluted');
    } finally {
      cleanup(dir);
    }
  });
  test('rejects invalid JSON after a valid journal snapshot', () => {
    const dir = makeTempDir();
    try {
      const request = {
        requestId: 'request_after_invalid_json',
        timestamp: ms('2026-06-22T10:00:00.000Z'),
        message: { text: 'This must not become evidence.' },
        agent: { extensionId: { value: 'GitHub.copilot-chat' } },
        response: [{ value: 'Nor should this reply.' }],
      };
      const content = [
        JSON.stringify({
          kind: 0,
          v: { version: 3, sessionId: 'invalid-json', requests: [] },
        }),
        '{"kind":',
        JSON.stringify({ kind: 2, k: ['requests'], v: [request] }),
      ].join('\n');
      expect(reconstructSession(content)).toEqual({});
      expect(parseCopilotChatTranscript(content, dir).messages).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
  test('strips the empty code fence Copilot leaves around a streamed edit', () => {
    const dir = makeTempDir();
    try {
      // Copilot streams an inline edit as the bare opening/closing ``` fence-marker
      // text parts wrapped around a (skipped) textEditGroup — leaving an empty fence.
      const doc = {
        sessionId: 's',
        requests: [
          {
            requestId: 'r1',
            timestamp: ms('2026-06-22T10:00:00.000Z'),
            message: { text: 'edit the file' },
            agent: { extensionId: { value: 'GitHub.copilot-chat' } },
            response: [
              { value: 'Updating the file.\n\n' },
              { value: '```python\n' },
              {
                kind: 'textEditGroup',
                uri: { fsPath: join(dir, 'x.py') },
                edits: [[{ text: 'print(1)', range: {} }]],
              },
              { value: '\n```\n' },
              { value: 'Done.' },
            ],
          },
        ],
      };
      const parsed = parseCopilotChatTranscript(JSON.stringify(doc), dir);
      const reply = parsed.messages.find((m) => m.role === 'assistant')!;
      expect(reply.text).not.toContain('```'); // no empty fence / blank box
      expect(reply.text).toContain('Updating the file.');
      expect(reply.text).toContain('Done.');
      // The actual edit is still captured separately as a diff.
      expect(parsed.messages.find((m) => m.role === 'edit')?.files).toEqual(['x.py']);
    } finally {
      cleanup(dir);
    }
  });
  test('a turn’s decision is timestamped before the reply and after the prompt', () => {
    const dir = makeTempDir();
    try {
      // makeSession's request_1 has a prompt, a vscode_askQuestions decision, and a
      // streamed reply — answered mid-turn, the decision must sort between them so the
      // report stops pushing it to the bottom of the turn.
      const parsed = parseCopilotChatTranscript(makeSession(dir), dir);
      const inR1 = (role: string) =>
        parsed.messages.find((m) => m.role === role && m.sourceId.includes('request_1'))!;
      const promptTs = ms(inR1('user').timestamp!);
      const decisionTs = ms(
        parsed.messages.find((m) => m.role === 'decision')!.timestamp!,
      );
      const replyTs = ms(inR1('assistant').timestamp!);
      expect(decisionTs).toBeGreaterThan(promptTs);
      expect(decisionTs).toBeLessThan(replyTs);
    } finally {
      cleanup(dir);
    }
  });
});
describe('copilot import (end to end via --file)', () => {});
describe('summarizeChatSessions (discovery by workspace.json folder)', () => {});
