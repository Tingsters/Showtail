import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  copilotCliSessionsDir,
  findCopilotCliSession,
  parseCopilotCliSession,
  parseCopilotCliTranscript,
} from '../src/core/copilotCliTranscript.ts';
import { copilotCliPlugin } from '../src/plugins/copilot-cli.ts';
import { cleanup, makeTempDir } from './helpers.ts';

/**
 * Build a synthetic Copilot CLI `events.jsonl` (one JSON object per line) mixing
 * the event shapes we keep — `session.start`, `user.message`,
 * `assistant.message` (text reply), `tool.execution_start` (a file edit) — with
 * the noise we must drop: the chrome-only `transformedContent`, a tool-only
 * assistant turn (empty `content`), a non-edit tool call (`rename_session`), and
 * an edit to an internal `.copilot` file.
 *
 * Copilot CLI records NO plan/decision construct in events.jsonl (its todo/plan
 * tool persists to per-session SQLite), so there is intentionally no plan or
 * decision line here — the parser must not invent one.
 */
function makeEvents(dir: string, sessionId: string): string {
  const lines: unknown[] = [
    {
      type: 'session.start',
      data: {
        sessionId,
        copilotVersion: '1.0.64-1',
        context: { cwd: dir, gitRoot: dir },
      },
      id: 'evt-1',
      timestamp: '2026-06-22T19:22:56.963Z',
      parentId: null,
    },
    // The student's typed prompt — kept (clean `content`, not `transformedContent`).
    {
      type: 'user.message',
      data: {
        content: 'Edit notes.txt so its contents become banana-copilot.',
        transformedContent:
          '<current_datetime>2026-06-22T19:22:59-07:00</current_datetime>\n\nEdit notes.txt ...\n\n<system_reminder>NOISE</system_reminder>',
        attachments: [],
      },
      id: 'evt-2',
      timestamp: '2026-06-22T19:22:59.478Z',
      parentId: 'evt-1',
    },
    // A tool-only assistant turn (renaming the session) — empty content, dropped.
    {
      type: 'assistant.message',
      data: {
        messageId: 'msg-rename',
        content: '',
        toolRequests: [
          {
            toolCallId: 'call_rename',
            name: 'rename_session',
            arguments: { title: 'Notes edit' },
            type: 'function',
          },
        ],
      },
      id: 'evt-3',
      timestamp: '2026-06-22T19:23:00.000Z',
      parentId: 'evt-2',
    },
    // A non-edit tool call — dropped (no path argument).
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call_rename',
        toolName: 'rename_session',
        arguments: { title: 'Notes edit' },
      },
      id: 'evt-4',
      timestamp: '2026-06-22T19:23:00.100Z',
      parentId: 'evt-3',
    },
    // A file edit — kept (in-repo, absolute path normalized to repo-relative).
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call_edit',
        toolName: 'str_replace',
        arguments: {
          path: join(dir, 'notes.txt'),
          old_str: 'old',
          new_str: 'banana-copilot',
        },
      },
      id: 'evt-5',
      timestamp: '2026-06-22T19:23:01.000Z',
      parentId: 'evt-3',
    },
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call_edit',
        result: { changed: true },
        stdout: 'updated\n',
        stderr: '',
        exitCode: 0,
      },
      id: 'evt-5b',
      timestamp: '2026-06-22T19:23:01.250Z',
      parentId: 'evt-5',
    },
    // An edit to an internal .copilot file — dropped.
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call_internal',
        toolName: 'write_file',
        arguments: { path: '.copilot/config.json', content: '{}' },
      },
      id: 'evt-6',
      timestamp: '2026-06-22T19:23:01.500Z',
      parentId: 'evt-3',
    },
    // The assistant's text reply — kept.
    {
      type: 'assistant.message',
      data: {
        messageId: 'msg-reply',
        model: 'gpt-5.3-codex',
        content: 'Done — notes.txt now reads banana-copilot.',
        toolRequests: [],
      },
      id: 'evt-7',
      timestamp: '2026-06-22T19:23:02.000Z',
      parentId: 'evt-3',
    },
    {
      type: 'session.shutdown',
      data: {},
      id: 'evt-8',
      timestamp: '2026-06-22T19:23:03.000Z',
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseCopilotCliSession', () => {
  test('keeps prompt, assistant reply and the repo edit; drops the noise', () => {
    const dir = makeTempDir();
    try {
      const parsed = parseCopilotCliSession(makeEvents(dir, 'sess-copilot-1'), dir);
      expect(parsed.sessionId).toBe('sess-copilot-1');

      const roles = parsed.messages.map((m) => m.role);
      expect(roles.filter((r) => r === 'user').length).toBe(1);
      expect(roles.filter((r) => r === 'assistant').length).toBe(1);
      expect(roles.filter((r) => r === 'edit').length).toBe(1);

      const blob = parsed.messages.map((m) => m.text).join('\n');
      expect(blob).not.toContain('system_reminder');
      expect(blob).not.toContain('config.json');

      // The edit's absolute path is normalized to a repo-relative file.
      const edit = parsed.messages.find((m) => m.role === 'edit')!;
      expect(edit.files).toEqual(['notes.txt']);

      // The reply uses the model's messageId for a stable source id.
      const reply = parsed.messages.find((m) => m.role === 'assistant')!;
      expect(reply.sourceId).toBe('copilot:asst:msg-reply');
      expect(reply.text).toContain('banana-copilot');
      expect(
        parsed.events.some(
          (event) =>
            event.type === 'tool_use' &&
            event.toolUseId === 'call_edit' &&
            event.toolName === 'str_replace',
        ),
      ).toBe(true);
      expect(
        parsed.events.find(
          (event) => event.type === 'tool_result' && event.toolUseId === 'call_edit',
        ),
      ).toMatchObject({
        stdout: 'updated\n',
        stderr: '',
        exitCode: 0,
      });

      // Timestamps preserved for back-dating.
      expect(parsed.messages[0]!.timestamp).toBe('2026-06-22T19:22:59.478Z');
    } finally {
      cleanup(dir);
    }
  });

  test('parseCopilotCliTranscript drops edits, keeping prompt + reply with stable ids', () => {
    const dir = makeTempDir();
    try {
      const t = parseCopilotCliTranscript(makeEvents(dir, 'sess-copilot-1'), dir);
      expect(t.sessionId).toBe('sess-copilot-1');
      expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(t.messages[0]!.sourceId).toBe('copilot:user:sess-copilot-1:0');
      expect(t.messages[0]!.text).toContain('banana-copilot');
      expect(t.messages[1]!.sourceId).toBe('copilot:asst:msg-reply');
      // No plan/decision construct exists in Copilot CLI logs, so none is emitted.
      expect(t.messages.some((m) => m.role === 'plan' || m.role === 'decision')).toBe(
        false,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('malformed lines are skipped, never thrown', () => {
    const parsed = parseCopilotCliSession(
      'not json\n{"type":"user.message","data":{"content":"hi"}}\n{bad\n',
      '/tmp/root',
    );
    expect(parsed.messages.map((m) => m.text)).toEqual(['hi']);
  });
});

describe('Copilot CLI session discovery + plugin getTranscript', () => {
  const saved = process.env.COPILOT_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = saved;
  });

  /** Write one synthetic session under a COPILOT_HOME and return paths/ids. */
  function seedSession(sessionId: string, repo: string): string {
    const home = makeTempDir();
    process.env.COPILOT_HOME = home;
    const dir = join(home, 'session-state', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), makeEvents(repo, sessionId), 'utf8');
    return home;
  }

  test('copilotCliSessionsDir honors the COPILOT_HOME override', () => {
    process.env.COPILOT_HOME = '/custom/home';
    expect(copilotCliSessionsDir()).toBe(join('/custom/home', 'session-state'));
  });

  test('findCopilotCliSession locates a session by id', () => {
    const repo = makeTempDir();
    const home = seedSession('abc-123', repo);
    try {
      const info = findCopilotCliSession('abc-123');
      expect(info?.sessionId).toBe('abc-123');
      expect(info?.path).toBe(join(home, 'session-state', 'abc-123', 'events.jsonl'));
    } finally {
      cleanup(home);
      cleanup(repo);
    }
  });

  test('plugin getTranscript reads the session by id from the Stop payload', () => {
    const repo = makeTempDir();
    const home = seedSession('payload-sid', repo);
    try {
      const transcript = copilotCliPlugin.connect!.hooks!.getTranscript!(
        { session_id: 'payload-sid', hook_event_name: 'Stop' },
        repo,
      );
      expect(transcript).not.toBeNull();
      expect(transcript!.sessionId).toBe('payload-sid');
      expect(transcript!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(transcript!.messages[1]!.text).toContain('banana-copilot');
    } finally {
      cleanup(home);
      cleanup(repo);
    }
  });

  test('plugin getTranscript falls back to the newest session and is null when none', () => {
    // No COPILOT_HOME session-state dir at all → null (stop stays a no-op).
    process.env.COPILOT_HOME = makeTempDir();
    expect(
      copilotCliPlugin.connect!.hooks!.getTranscript!({ hook_event_name: 'Stop' }, '/r'),
    ).toBeNull();
    cleanup(process.env.COPILOT_HOME);

    // With a session present but no matching id, fall back to newest.
    const repo = makeTempDir();
    const home = seedSession('only-one', repo);
    try {
      const transcript = copilotCliPlugin.connect!.hooks!.getTranscript!(
        { hook_event_name: 'Stop' },
        repo,
      );
      expect(transcript?.sessionId).toBe('only-one');
    } finally {
      cleanup(home);
      cleanup(repo);
    }
  });
});
