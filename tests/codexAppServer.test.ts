import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import {
  CodexAppServerError,
  cleanUnifiedDiff,
  openCodexRpc,
  readThread,
  readThreadTranscript,
  threadToTranscript,
  type CodexRpc,
  type ThreadEntry,
} from '../src/core/codexAppServer.ts';
import {
  readCodexSession,
  rolloutFormatWarning,
  unreadableRolloutItems,
  parseCodexTranscript,
} from '../src/core/codexTranscript.ts';
import { codexPlugin } from '../src/plugins/codex.ts';
import { cleanup, makeTempDir, readJsonReport, runCli } from './helpers.ts';

/**
 * Codex's rollout file is an internal format that changed under us at v0.148, so
 * Showtail now reads sessions through Codex's app-server (documented ThreadItems) and
 * takes edits/replies from the documented hook payloads. The fixtures here are REAL
 * responses and hook payloads recorded from Codex 0.163 and 0.141 (paths sanitized to
 * `__ROOT__`); see tests/fixtures/codex.
 */

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex');

/** Load a fixture with `__ROOT__` replaced by a real (forward-slash) project root. */
function load<T>(name: string, root: string): T {
  const text = readFileSync(join(FIXTURES, name), 'utf8');
  return JSON.parse(text.split('__ROOT__').join(root.split(sep).join('/'))) as T;
}

/** A fake app-server. Unhandled methods answer like Codex does for unsupported ones. */
function fakeRpc(handlers: Record<string, (params: any) => unknown>): CodexRpc {
  return {
    async request(method, params) {
      const h = handlers[method];
      if (!h) throw new CodexAppServerError(`${method} is not supported yet`, -32601);
      return h(params);
    },
    close() {},
  };
}

// Isolate the machine-local ledger per test (the CLI-spawning tests below write to it).
let prevHome: string | undefined;
let home: string | undefined;
beforeEach(() => {
  prevHome = process.env.SHOWTAIL_HOME;
  home = makeTempDir();
  process.env.SHOWTAIL_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prevHome;
  if (home) cleanup(home);
});

describe('threadToTranscript: Codex 0.163 (real recorded thread)', () => {
  test('maps prompt, commentary + final reply, and every edit with a clean diff', () => {
    const root = makeTempDir();
    try {
      const entries = load<ThreadEntry[]>('appserver-0.163-items.json', root);
      const t = threadToTranscript('thread-163', entries, { root, model: 'gpt-6.1-sol' });

      expect(t.messages.filter((m) => m.role === 'user')).toHaveLength(1);

      const replies = t.messages.filter((m) => m.role === 'assistant');
      expect(replies).toHaveLength(8); // 7 commentary + 1 final answer, nothing dropped
      expect(replies.filter((m) => m.isFinal)).toHaveLength(1);
      expect(replies.every((m) => m.model === 'gpt-6.1-sol')).toBe(true);
      expect(replies.at(-1)!.isFinal).toBe(true);

      // add, update, add, delete: each its own edit with the clean `+ `/`- ` diff.
      const edits = t.messages.filter((m) => m.role === 'edit');
      expect(edits).toHaveLength(4);
      expect(edits.map((e) => e.edits![0]!.file)).toEqual([
        'notes.txt',
        'notes.txt',
        'tmp.txt',
        'tmp.txt',
      ]);
      expect(edits[0]!.edits![0]!.diff).toBe('+ alpha\n+ beta');
      expect(edits[1]!.edits![0]!.diff).toBe('- beta\n+ gamma');
      expect(edits[2]!.edits![0]!.diff).toBe('+ scratch');
      expect(edits[3]!.edits![0]).toMatchObject({
        file: 'tmp.txt',
        deleted: true,
        diff: '- scratch',
      });

      // Every message is timestamped from the item times, in order.
      expect(t.messages.every((m) => typeof m.timestamp === 'string')).toBe(true);
      const times = t.messages.map((m) => m.timestamp!);
      expect([...times].sort()).toEqual(times);
      // Conversation events are produced too (user/assistant text + tool calls).
      expect(new Set(t.events.map((e) => e.type))).toEqual(
        new Set(['user_text', 'assistant_text', 'tool_use', 'tool_result']),
      );
    } finally {
      cleanup(root);
    }
  });

  test('keeps the file parser source-id schemes so earlier captures dedupe', () => {
    const root = makeTempDir();
    try {
      const entries = load<ThreadEntry[]>('appserver-0.163-items.json', root);
      const t = threadToTranscript('thread-163', entries, { root });
      expect(t.messages.find((m) => m.role === 'user')!.sourceId).toBe(
        'codex:user:thread-163:0',
      );
      expect(t.messages.filter((m) => m.role === 'assistant')[0]!.sourceId).toBe(
        'codex:asst:thread-163:0',
      );
      expect(t.messages.find((m) => m.role === 'edit')!.sourceId).toMatch(
        /^codex:edit:exec-/,
      );
    } finally {
      cleanup(root);
    }
  });

  test('drops edits outside the project, in .codex/.showtail, and non-completed ones', () => {
    const root = makeTempDir();
    try {
      const at = (path: string, status = 'completed') => ({
        item: {
          type: 'fileChange',
          id: `fc-${path}-${status}`,
          status,
          changes: [{ path, kind: { type: 'add' }, diff: 'x\n' }],
        },
        completedAtMs: 1,
      });
      const r = root.split(sep).join('/');
      const t = threadToTranscript(
        'tid',
        [
          at(`${r}/src/keep.ts`),
          at('/elsewhere/outside.ts'),
          at(`${r}/.codex/config.toml`),
          at(`${r}/.showtail/x`),
          at(`${r}/failed.ts`, 'failed'),
          at(`${r}/declined.ts`, 'declined'),
        ],
        { root },
      );
      expect(t.messages.filter((m) => m.role === 'edit').map((m) => m.files)).toEqual([
        ['src/keep.ts'],
      ]);
    } finally {
      cleanup(root);
    }
  });
});

describe('legacy-store threads (Codex 0.139-0.142)', () => {
  test('falls back to thread/turns/list when thread/items/list is unsupported', async () => {
    const root = makeTempDir();
    try {
      const turns = load<unknown[]>('appserver-0.141-turns.json', root);
      const calls: string[] = [];
      const rpc = fakeRpc({
        'thread/turns/list': (p) => {
          calls.push(`turns:${p.itemsView}`);
          return { data: turns, nextCursor: null };
        },
        'thread/read': () => ({
          thread: { model: 'gpt-5.5', cwd: root, cliVersion: '0.141.0' },
        }),
      });
      const read = await readThread(rpc, 'legacy');
      expect(read.via).toBe('turns');
      expect(read.cliVersion).toBe('0.141.0');
      expect(calls).toEqual(['turns:full']);

      const t = threadToTranscript('legacy', read.entries, { root });
      expect(t.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'edit',
        'assistant',
      ]);
      // Legacy turns only carry second-resolution times: order must still be preserved.
      const times = t.messages.map((m) => m.timestamp!);
      expect([...times].sort()).toEqual(times);
      expect(t.messages.find((m) => m.role === 'edit')!.edits![0]).toMatchObject({
        file: 'notes.txt',
      });
    } finally {
      cleanup(root);
    }
  });

  test('a real server error other than "unsupported" is not swallowed', async () => {
    const rpc = fakeRpc({
      'thread/items/list': () => {
        throw new CodexAppServerError('thread not found', -32600);
      },
    });
    await expect(readThread(rpc, 'x')).rejects.toThrow('thread not found');
  });
});

describe('non-blocking questions through the app-server', () => {
  const entries = (): ThreadEntry[] => [
    {
      item: {
        type: 'userMessage',
        id: 'u1',
        content: [{ type: 'text', text: 'test the robot' }],
      },
      completedAtMs: 1000,
    },
    {
      item: {
        type: 'agentMessage',
        id: 'call_abc',
        text: 'Is it on?\n- Yes\n- No',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Is it on?', options: ['Yes', 'No'] }],
      },
      completedAtMs: 2000,
    },
    {
      item: {
        type: 'agentMessage',
        id: 'a2',
        text: 'Carrying on meanwhile.',
        phase: 'commentary',
      },
      completedAtMs: 3000,
    },
    {
      item: {
        type: 'userMessage',
        id: 'u2',
        content: [
          {
            type: 'text',
            text:
              '<send_user_message_question_reply>\n' +
              JSON.stringify([
                {
                  answer: 'Yes',
                  question: 'Is it on?',
                  questionItemId: '["request_user_input_async","call_abc",0]',
                },
              ]) +
              '\n</send_user_message_question_reply>',
          },
        ],
      },
      completedAtMs: 4000,
    },
  ];

  test('the echo is the question, the envelope is the answer, neither is a prompt or reply', () => {
    const t = threadToTranscript('tid', entries(), { root: process.cwd() });
    expect(t.messages.map((m) => m.role)).toEqual([
      'user',
      'decision',
      'assistant',
      'decision',
    ]);
    const [ask, answer] = t.messages.filter((m) => m.role === 'decision');
    expect(ask!.sourceId).toBe('codex:decision-ask:call_abc');
    expect(answer!.sourceId).toBe('codex:decision:call_abc');
    expect(ask!.text).toContain('**Codex asked (non-blocking):** Is it on?');
    expect(answer!.text).toContain('- **Yes** ✅ _(your choice)_');
    // Chronological, like the Codex terminal: question, Codex's work, then the answer.
    expect(t.messages.map((m) => m.timestamp)).toEqual(
      [1000, 2000, 3000, 4000].map((ms) => new Date(ms).toISOString()),
    );
  });

  test('a malformed envelope is preserved as the student words, never dropped', () => {
    const raw =
      '<send_user_message_question_reply>not json</send_user_message_question_reply>';
    const t = threadToTranscript(
      'tid',
      [
        {
          item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: raw }] },
          completedAtMs: 1,
        },
      ],
      { root: process.cwd() },
    );
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ role: 'decision', text: raw });
  });
});

describe('readThreadTranscript', () => {
  test('uses an injected client end to end and stamps the thread model', async () => {
    const root = makeTempDir();
    try {
      const entries = load<ThreadEntry[]>('appserver-0.163-items.json', root);
      const rpc = fakeRpc({
        'thread/items/list': () => ({
          data: entries.map((e) => ({ ...e, turnId: 't' })),
          nextCursor: null,
        }),
        'thread/read': () => ({ thread: { model: 'thread-model' } }),
      });
      const r = await readThreadTranscript('tid', { root, rpc });
      expect(r.via).toBe('items');
      expect(r.transcript.messages.find((m) => m.role === 'assistant')!.model).toBe(
        'thread-model',
      );
    } finally {
      cleanup(root);
    }
  });

  test('cleanUnifiedDiff keeps only changed lines, in Showtail form', () => {
    expect(cleanUnifiedDiff('@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n')).toBe(
      '- beta\n+ gamma',
    );
    expect(cleanUnifiedDiff('--- a/x\n+++ b/x\n@@\n-a\r\n+b\r\n')).toBe('- a\n+ b');
  });
});

/** Every journal record of `kind` in a project's trail, parsed. */
function trailRecords(dir: string, kind: string): any[] {
  const out: any[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.log')) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (!line.includes(`"kind":"${kind}"`)) continue;
          out.push(JSON.parse(line));
        }
      }
    }
  };
  walk(join(dir, '.showtail', 'authors'));
  return out;
}

describe('live hook payloads (real Codex 0.163)', () => {
  type Hook = Record<string, any>;

  /** Run each recorded hook payload through `showtail hook <event> --tool codex`. */
  function replay(dir: string, hooks: Hook[], opts: { skipStop?: boolean } = {}): void {
    for (const h of hooks) {
      const event =
        h.hook_event_name === 'UserPromptSubmit'
          ? 'user-prompt'
          : h.hook_event_name === 'PostToolUse'
            ? 'post-edit'
            : 'stop';
      if (event === 'stop' && opts.skipStop) continue;
      const r = runCli(dir, ['hook', event, '--tool', 'codex'], {
        input: JSON.stringify(h),
      });
      expect(r.code).toBe(0);
    }
  }

  test('apply_patch edits arrive in tool_input.command and are captured with diffs', () => {
    const dir = makeTempDir();
    try {
      runCli(dir, ['track', '--project', 'Hook Contract']);
      const hooks = load<Hook[]>('hooks-0.163.json', dir);
      replay(dir, hooks, { skipStop: true });

      // The documented `tool_input.command` is what Showtail used to miss, so every
      // one of these edits was silently dropped on Codex >= 0.148. All four patches
      // (add, update, add, delete) must reach the trail as artifacts.
      const artifacts = trailRecords(dir, 'artifact');
      expect(artifacts.map((a) => a.path)).toEqual([
        'notes.txt',
        'notes.txt',
        'tmp.txt',
        'tmp.txt',
      ]);

      // The report groups by file, but each file shows its diff.
      runCli(dir, ['report', '--format', 'json']);
      const changes = readJsonReport(dir).turns[0].codeChanges as {
        path: string;
        diff?: string;
      }[];
      expect(changes.map((c) => c.path).sort()).toEqual(['notes.txt', 'tmp.txt']);
      expect(changes.find((c) => c.path === 'notes.txt')!.diff).toContain('+ alpha');
    } finally {
      cleanup(dir);
    }
  });

  test('Stop.last_assistant_message is captured even with no Codex history to read', () => {
    const dir = makeTempDir();
    try {
      runCli(dir, ['track', '--project', 'Hook Final Reply']);
      const hooks = load<Hook[]>('hooks-0.163.json', dir);
      replay(dir, hooks);

      runCli(dir, ['report', '--format', 'json']);
      const turn = readJsonReport(dir).turns[0];
      const stop = hooks.find((h) => h.hook_event_name === 'Stop')!;
      // No app-server (tests point SHOWTAIL_CODEX_BIN at nothing) and no rollout: the
      // documented hook field alone must still yield the final reply under its prompt.
      expect(turn.aiOutputs.map((o: any) => o.text)).toContain(
        stop.last_assistant_message,
      );

      // ...and the degraded read is visible, not silent.
      const diag = join(dir, '.showtail', 'diag', 'hooks.jsonl');
      if (existsSync(diag)) {
        const stopTrace = readFileSync(diag, 'utf8')
          .split('\n')
          .filter((l) => l.includes('"event":"stop"'))
          .at(-1);
        expect(stopTrace).toContain('app-server was unavailable');
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('plugin getTranscript tiers', () => {
  test('hook-only baseline anchors on the current turn and warns', async () => {
    const root = makeTempDir();
    try {
      const t = await codexPlugin.connect!.hooks!.getTranscript!(
        {
          session_id: 'sess-1',
          turn_id: 'turn-9',
          model: 'm',
          last_assistant_message: 'Done.',
        },
        root,
      );
      expect(t).not.toBeNull();
      expect(t!.anchorToCurrentTurn).toBe(true);
      expect(t!.messages).toHaveLength(1);
      expect(t!.messages[0]).toMatchObject({
        role: 'assistant',
        text: 'Done.',
        sourceId: 'codex:final:turn-9',
        isFinal: true,
        model: 'm',
      });
      expect(t!.warnings!.join(' ')).toContain('app-server was unavailable');
    } finally {
      cleanup(root);
    }
  });

  test('no session id and no reply means nothing to capture', async () => {
    expect(
      await codexPlugin.connect!.hooks!.getTranscript!({}, process.cwd()),
    ).toBeNull();
  });
});

describe('tripwire: a rollout the file reader cannot read is reported, not zeroed', () => {
  // A post-0.148 rollout: messages and edits only as item_completed items.
  const newFormat = [
    { type: 'session_meta', payload: { id: 'sid', cwd: 'x', cli_version: '0.163.0' } },
    ...['UserMessage', 'AgentMessage', 'FileChange'].map((type, i) => ({
      timestamp: `2026-10-19T00:00:0${i}.000Z`,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type, id: `i${i}` } },
    })),
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');

  test('counts the unreadable items and words a warning', () => {
    expect(unreadableRolloutItems(newFormat)).toBe(3);
    const parsed = parseCodexTranscript(newFormat, 'x');
    expect(rolloutFormatWarning(newFormat, parsed)).toContain('newer format');
  });

  test('no warning for an old-format rollout or an empty one', () => {
    const old = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hi' },
    });
    expect(rolloutFormatWarning(old, parseCodexTranscript(old, 'x'))).toBeUndefined();
    expect(rolloutFormatWarning('', parseCodexTranscript('', 'x'))).toBeUndefined();
  });

  test('import falls back to the file reader and says why', async () => {
    const dir = makeTempDir();
    try {
      const path = join(
        dir,
        'rollout-2026-10-19T00-00-00-019ef1c4-1899-7a90-bb9f-b09bca10e91c.jsonl',
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, newFormat);
      const read = await readCodexSession(path, dir);
      expect(read.via).toBe('file');
      expect(read.warnings.join(' ')).toContain('app-server was unavailable');
      expect(read.warnings.join(' ')).toContain('newer format');
    } finally {
      cleanup(dir);
    }
  });
});

describe('openCodexRpc transport (real subprocess)', () => {
  /** A stand-in for `codex app-server`: newline-delimited JSON-RPC over stdio. */
  const fakeServer = (mode: 'ok' | 'die'): string => `
    if (${JSON.stringify(mode)} === 'die') process.exit(3);
    const NL = String.fromCharCode(10);
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      for (let i = buf.indexOf(NL); i >= 0; i = buf.indexOf(NL)) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id === undefined) continue; // the 'initialized' notification
        const reply = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + NL);
        process.stdout.write('not json: a banner line' + NL); // must be ignored
        if (m.method === 'initialize') reply({ result: { userAgent: 'fake' } });
        else if (m.method === 'thread/items/list') reply({ result: { data: [{ item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'hi' }] }, completedAtMs: 5 }], nextCursor: null } });
        else if (m.method === 'thread/read') reply({ result: { thread: { model: 'fake-model' } } });
        else reply({ error: { code: -32601, message: m.method + ' is not supported yet' } });
      }
    });`;

  const script = (dir: string, mode: 'ok' | 'die'): string => {
    const p = join(dir, `fake-${mode}.js`);
    writeFileSync(p, fakeServer(mode));
    return p;
  };

  test('speaks the protocol: handshake, requests, error codes, banner noise ignored', async () => {
    const dir = makeTempDir();
    try {
      const rpc = await openCodexRpc({
        bin: process.execPath,
        args: [script(dir, 'ok')],
      });
      try {
        const r = await readThreadTranscript('tid', { root: dir, rpc });
        expect(r.via).toBe('items');
        expect(r.transcript.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
        const error = await rpc.request('thread/nope', {}).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(CodexAppServerError);
        expect((error as CodexAppServerError).code).toBe(-32601);
      } finally {
        rpc.close();
      }
    } finally {
      cleanup(dir);
    }
  });

  test('a server that dies at startup fails fast with a clear error', async () => {
    const dir = makeTempDir();
    try {
      await expect(
        openCodexRpc({ bin: process.execPath, args: [script(dir, 'die')] }),
      ).rejects.toThrow(/exited/);
    } finally {
      cleanup(dir);
    }
  });

  test('a missing binary fails fast (no hang, no unhandled error)', async () => {
    await expect(
      openCodexRpc({ bin: join(makeTempDir(), 'no-such-codex'), requestTimeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(CodexAppServerError);
  });
});
