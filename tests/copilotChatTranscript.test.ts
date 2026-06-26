import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInit } from '../src/commands/init.ts';
import { runImportCopilot } from '../src/commands/importCopilot.ts';
import { runImportUndo } from '../src/commands/import.ts';
import {
  parseCopilotChatTranscript,
  summarizeChatSessions,
} from '../src/core/copilotChatTranscript.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import { readLedgerRecords, unplacedSessions } from '../src/core/ledger.ts';
import { buildReportData, renderHtml } from '../src/core/report.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

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
});

describe('copilot import (end to end via --file)', () => {
  test('imports prompts/responses/edits back-dated; dedupes; undo removes the batch', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'session.json');
      writeFileSync(fixture, makeSession(dir), 'utf8');

      await runImportCopilot(undefined, { file: fixture, withResponses: true, cwd: dir });

      const cp = () => readAllEvents(paths).filter((e) => e.tool === 'github-copilot');
      const cpArtifacts = () =>
        readAllArtifacts(paths).filter((a) => a.tool === 'github-copilot');
      const imported = cp();
      expect(imported.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(imported.filter((e) => e.type === 'ai_output').length).toBe(2);

      const artifacts = cpArtifacts();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]!.path).toBe('src/foo.ts');
      expect(artifacts[0]!.diffHash).toBeTruthy();
      expect(artifacts[0]!.timestamp.startsWith('2026-06-22')).toBe(true);

      expect(imported.every((e) => e.batchId)).toBe(true);
      expect(imported.every((e) => e.tags?.includes('imported'))).toBe(true);
      expect(imported.every((e) => e.timestamp.startsWith('2026-06-22'))).toBe(true);

      // Plan + decision events: imported, no plan-approval tag (agent-generated).
      const plans = imported.filter((e) => e.type === 'plan');
      const decisions = imported.filter((e) => e.type === 'decision');
      expect(plans.length).toBe(1);
      expect(decisions.length).toBe(1);
      expect(plans[0]!.tags ?? []).not.toContain('plan-approved');
      expect(plans[0]!.tags ?? []).not.toContain('plan-revised');

      // The report renders the same card set as Codex/Antigravity: a plan card (no
      // badge), a decision card, and a code diff.
      const html = renderHtml(buildReportData(paths));
      const planSummary =
        /<details class="plan">\s*<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? '';
      expect(planSummary).toContain('📋 Plan');
      expect(planSummary).not.toContain('Approved');
      expect(planSummary).not.toContain('Revised');
      expect(html).toContain('class="decision"');
      expect(html).toContain('🔀 Decision');
      expect(html).toContain('Quiz mode');
      expect(html).toContain('<details class="code">');

      const count = imported.length;
      const artifactCount = artifacts.length;

      // Re-importing the same session adds nothing (events + artifacts deduped).
      await runImportCopilot(undefined, { file: fixture, withResponses: true, cwd: dir });
      expect(cp().length).toBe(count);
      expect(cpArtifacts().length).toBe(artifactCount);

      // Undo removes the whole batch — events and the imported edit artifacts.
      await runImportUndo({ cwd: dir });
      expect(cp().length).toBe(0);
      expect(cpArtifacts().length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('without --with-responses, only prompts and edits are imported', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const fixture = join(dir, 'session.json');
      writeFileSync(fixture, makeSession(dir), 'utf8');

      await runImportCopilot(undefined, { file: fixture, cwd: dir });

      const cp = readAllEvents(paths).filter((e) => e.tool === 'github-copilot');
      expect(cp.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(cp.filter((e) => e.type === 'ai_output').length).toBe(0);
      expect(
        readAllArtifacts(paths).filter((a) => a.tool === 'github-copilot').length,
      ).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('--auto routes a no-folder session into the edited file’s project', async () => {
    const proj = makeTempDir(); // the project whose file Copilot edited
    const elsewhere = makeTempDir(); // invocation cwd — NOT a tracked project
    try {
      await runInit({ cwd: proj });
      mkdirSync(join(proj, 'src'), { recursive: true });
      const projPaths = pathsForRoot(proj);

      // An empty-window journal whose edit targets <proj>/src/foo.ts.
      const file = join(elsewhere, 'empty-window.jsonl');
      writeFileSync(file, makeJournal(proj), 'utf8');

      await runImportCopilot(undefined, {
        file,
        auto: true,
        withResponses: true,
        cwd: elsewhere,
      });

      // The whole conversation + the edit landed in <proj>'s trail (routed by path),
      // even though the invocation cwd was elsewhere.
      const cp = readAllEvents(projPaths).filter((e) => e.tool === 'github-copilot');
      expect(cp.filter((e) => e.type === 'prompt').length).toBe(2);
      expect(cp.filter((e) => e.type === 'ai_output').length).toBe(2);
      const arts = readAllArtifacts(projPaths).filter((a) => a.tool === 'github-copilot');
      expect(arts.length).toBe(1);
      expect(arts[0]!.path).toBe('src/foo.ts');

      // Idempotent: re-running --auto adds nothing.
      await runImportCopilot(undefined, {
        file,
        auto: true,
        withResponses: true,
        cwd: elsewhere,
      });
      expect(
        readAllEvents(projPaths).filter((e) => e.tool === 'github-copilot').length,
      ).toBe(cp.length);
    } finally {
      cleanup(proj);
      cleanup(elsewhere);
    }
  });

  test('--auto parks a folderless session in the inbox, never the ~/.showtail catch-all', async () => {
    const scratch = makeTempDir(); // edits live here; no enclosing `.showtail/`
    const elsewhere = makeTempDir(); // invocation cwd — also untracked
    try {
      const file = join(elsewhere, 'empty-window.jsonl');
      writeFileSync(file, makeJournal(scratch), 'utf8'); // edits target scratch/src/foo.ts

      await runImportCopilot(undefined, {
        file,
        auto: true,
        withResponses: true,
        cwd: elsewhere,
      });

      // No trail was invented anywhere…
      expect(existsSync(join(scratch, '.showtail'))).toBe(false);
      expect(existsSync(join(elsewhere, '.showtail'))).toBe(false);
      // …and the conversation was parked in the inbox (the ledger).
      const inbox = unplacedSessions().filter((s) => s.tool === 'github-copilot');
      expect(inbox).toHaveLength(1);
      const recs = readLedgerRecords(inbox[0]!.id);
      const kinds = recs.map((r) => r.kind);
      expect(recs.filter((r) => r.kind === 'prompt').length).toBe(2);
      expect(kinds).toContain('ai_output');
      expect(kinds).toContain('edit');

      // Idempotent: re-running --auto adds no new records and no new session.
      const before = recs.length;
      await runImportCopilot(undefined, {
        file,
        auto: true,
        withResponses: true,
        cwd: elsewhere,
      });
      const inbox2 = unplacedSessions().filter((s) => s.tool === 'github-copilot');
      expect(inbox2).toHaveLength(1);
      expect(readLedgerRecords(inbox2[0]!.id).length).toBe(before);
    } finally {
      cleanup(scratch);
      cleanup(elsewhere);
    }
  });
});

describe('summarizeChatSessions (discovery by workspace.json folder)', () => {
  test('finds this project session under workspaceStorage and tracks import state', async () => {
    const dir = makeTempDir();
    const storage = makeTempDir(); // stands in for …/Code/User/workspaceStorage
    const prev = process.env.SHOWTAIL_VSCODE_STORAGE;
    process.env.SHOWTAIL_VSCODE_STORAGE = storage;
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      // Lay out workspaceStorage/<hash>/{workspace.json, chatSessions/<id>.jsonl}
      // using the current VS Code `.jsonl` patch-journal format.
      const hashDir = join(storage, 'abc123hash');
      mkdirSync(join(hashDir, 'chatSessions'), { recursive: true });
      writeFileSync(
        join(hashDir, 'workspace.json'),
        JSON.stringify({ folder: pathToFileURL(dir).href }),
        'utf8',
      );
      const sessionFile = join(hashDir, 'chatSessions', 'sess-copilot-1.jsonl');
      writeFileSync(sessionFile, makeJournal(dir), 'utf8');

      let summaries = summarizeChatSessions(author);
      expect(summaries.length).toBe(1);
      const s = summaries[0]!;
      expect(s.info.sessionId).toBe('sess-copilot-1');
      expect(s.promptCount).toBe(2);
      expect(s.editCount).toBe(1);
      expect(s.firstPrompt).toBe('Add a foo function.');
      expect(s.lastPrompt).toBe('Now add a test.');
      expect(s.importState).toBe('none');

      // After importing the whole session, it reads as fully imported.
      await runImportCopilot(undefined, {
        file: sessionFile,
        withResponses: true,
        cwd: dir,
      });
      summaries = summarizeChatSessions(author);
      expect(summaries[0]!.importState).toBe('full');
    } finally {
      if (prev === undefined) delete process.env.SHOWTAIL_VSCODE_STORAGE;
      else process.env.SHOWTAIL_VSCODE_STORAGE = prev;
      cleanup(dir);
      cleanup(storage);
    }
  });
});
