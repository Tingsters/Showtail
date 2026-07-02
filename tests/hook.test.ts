import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, readJsonReport, runCli, spawnEnv } from './helpers.ts';
import { isInternalPath } from '../src/commands/hook.ts';

/** Run `showtail <args>` in `cwd`, optionally piping `input` to stdin. */
function run(cwd: string, args: string[], input?: string) {
  return runCli(cwd, args, { input });
}

function initProject(dir: string) {
  run(dir, ['init', '--project', 'Hook Test']);
}

/** A typed-user transcript line. Pass `sessionId: null` to omit the field. */
function userLine(
  uuid: string,
  content: string,
  dir: string,
  sessionId: string | null = 'sess-1',
) {
  const line: any = {
    type: 'user',
    uuid,
    promptSource: 'typed',
    cwd: dir,
    message: { role: 'user', content },
  };
  if (sessionId !== null) line.sessionId = sessionId;
  return line;
}

/**
 * A user transcript line with an explicit `promptSource` (and optional explicit
 * `timestamp`), for tests that need a non-typed source or a back-dated prompt.
 */
function userLineWithSource(
  uuid: string,
  content: string,
  dir: string,
  promptSource: string,
  opts: { sessionId?: string; timestamp?: string } = {},
) {
  const line: any = {
    type: 'user',
    uuid,
    promptSource,
    sessionId: opts.sessionId ?? 'sess-1',
    cwd: dir,
    message: { role: 'user', content },
  };
  if (opts.timestamp) line.timestamp = opts.timestamp;
  return line;
}

/** An assistant text-reply transcript line. */
function asstLine(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
    },
  };
}

/** Write transcript `lines` to a uniquely named file in `dir` and return its path. */
function writeTranscript(dir: string, name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

describe('hook command (end-to-end via stdin)', () => {
  test('user-prompt hook logs a prompt event', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: dir,
        prompt: 'How should I structure the parser?',
      });
      const r = run(dir, ['hook', 'user-prompt'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(''); // must not pollute Claude's context

      const report = run(dir, ['report', '--format', 'json']);
      expect(report.code).toBe(0);
      // The prompt should now be captured in the trail.
      const trace = run(dir, ['report']);
      expect(trace.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit hook snapshots the edited file as an artifact', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      const payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_name: 'Edit',
        tool_input: { file_path: join(dir, 'parser.ts') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);

      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      expect(trace.code).toBe(0);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('session-start hook prints a one-line context note and creates a session', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: dir,
        source: 'startup',
      });
      const r = run(dir, ['hook', 'session-start'], payload);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Showtail is capturing');
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit ignores internal .showtail/.claude paths', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({
        tool_input: { file_path: join(dir, '.showtail', 'config.json') },
      });
      const r = run(dir, ['hook', 'post-edit'], payload);
      expect(r.code).toBe(0);
      // config.json should not have been recorded as an artifact.
      const trace = run(dir, ['trace', '.showtail/config.json', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('hooks are silent no-ops outside a Showtail project', () => {
    const dir = makeTempDir();
    try {
      // No `showtail init` here.
      const r = run(dir, ['hook', 'user-prompt'], JSON.stringify({ prompt: 'hi' }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      cleanup(dir);
    }
  });

  test('malformed stdin does not crash a hook', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const r = run(dir, ['hook', 'user-prompt'], 'not json at all');
      expect(r.code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test('status reports hooksActive once project hooks are connected', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(dir, ['connect', 'claude', '--project']); // hooks on by default
      const r = run(dir, ['status', '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).hooksActive).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('user-prompt --tool codex tags the prompt as codex', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({ cwd: dir, prompt: 'refactor the parser' });
      const r = run(dir, ['hook', 'user-prompt', '--tool', 'codex'], payload);
      expect(r.code).toBe(0);
      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.turns[0].prompt.tool).toBe('codex');
    } finally {
      cleanup(dir);
    }
  });

  test('stop hook attributes only the current turn, not transcript backlog', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup', session_id: 'sess-1' }),
      );

      // A persisted Claude Code transcript that already holds a prior
      // conversation (the "backlog"), then the current turn's prompt + reply.
      // Only the current turn's assistant message should be captured; the
      // backlog must not be dumped onto the new prompt.
      const lines = [
        {
          type: 'user',
          uuid: 'old-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'old backlog prompt' },
        },
        {
          type: 'assistant',
          uuid: 'old-a1',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'BACKLOG reply one' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'old-a2',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'BACKLOG reply two' }],
          },
        },
        {
          type: 'user',
          uuid: 'new-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'make the new change' },
        },
        {
          type: 'assistant',
          uuid: 'new-a',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'CURRENT reply applied' }],
          },
        },
      ];
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

      // The live hook captures the new prompt (opening the turn), then Stop.
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'make the new change', session_id: 'sess-1' }),
      );
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcriptPath }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);

      // Exactly one prompt was logged live, so exactly one turn — carrying only
      // the current turn's single reply, none of the backlog.
      expect(data.turns.length).toBe(1);
      const turn = data.turns[0];
      expect(turn.prompt.text).toBe('make the new change');
      expect(turn.aiOutputs.length).toBe(1);
      expect(turn.aiOutputs[0].text).toBe('CURRENT reply applied');

      // The backlog must not appear anywhere in the report.
      const blob = JSON.stringify(data);
      expect(blob).not.toContain('BACKLOG reply');
    } finally {
      cleanup(dir);
    }
  });

  test('stop hook attributes each reply to its own prompt across many turns', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup', session_id: 'sess-1' }),
      );

      // Two prompts logged live, before a single Stop captures both replies.
      // Each reply must land under its own prompt — not all on the last one.
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'first task', session_id: 'sess-1' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'second task', session_id: 'sess-1' }),
      );

      const lines = [
        {
          type: 'user',
          uuid: 'first-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'first task' },
        },
        {
          type: 'assistant',
          uuid: 'first-a',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'FIRST reply applied' }],
          },
        },
        {
          type: 'user',
          uuid: 'second-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          message: { role: 'user', content: 'second task' },
        },
        {
          type: 'assistant',
          uuid: 'second-a',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'SECOND reply applied' }],
          },
        },
      ];
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcriptPath }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);

      expect(data.turns.length).toBe(2);
      const first = data.turns.find((t: any) => t.prompt.text === 'first task');
      const second = data.turns.find((t: any) => t.prompt.text === 'second task');
      expect(first.aiOutputs.map((o: any) => o.text)).toEqual(['FIRST reply applied']);
      expect(second.aiOutputs.map((o: any) => o.text)).toEqual(['SECOND reply applied']);
    } finally {
      cleanup(dir);
    }
  });

  test('stop hook attributes replies for queued and suggestion_accepted prompts', () => {
    // End-to-end guard for the promptSource denylist: a prompt accepted from the
    // suggestion UI or queued while the AI was busy is a real user prompt and must
    // open its own turn. A regression to a {typed, paste} allowlist would drop the
    // middle/third prompts from the transcript walk and collapse their replies onto
    // the previous turn.
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup', session_id: 'sess-1' }),
      );
      // All three prompts are logged live (the live hook never filters by source).
      for (const prompt of ['first task', 'second task', 'third task']) {
        run(
          dir,
          ['hook', 'user-prompt'],
          JSON.stringify({ cwd: dir, prompt, session_id: 'sess-1' }),
        );
      }

      // In the transcript: first=typed, second=suggestion_accepted, third=queued.
      const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
        userLine('first-u', 'first task', dir),
        asstLine('first-a', 'FIRST reply'),
        userLineWithSource('second-u', 'second task', dir, 'suggestion_accepted'),
        asstLine('second-a', 'SECOND reply'),
        userLineWithSource('third-u', 'third task', dir, 'queued'),
        asstLine('third-a', 'THIRD reply'),
      ]);
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcriptPath }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const replies = (text: string) =>
        data.turns
          .find((t: any) => t.prompt.text === text)
          .aiOutputs.map((o: any) => o.text);

      expect(data.turns.length).toBe(3);
      expect(replies('first task')).toEqual(['FIRST reply']);
      expect(replies('second task')).toEqual(['SECOND reply']); // suggestion_accepted
      expect(replies('third task')).toEqual(['THIRD reply']); // queued
    } finally {
      cleanup(dir);
    }
  });

  test('stop hook back-fills a prompt the live hook missed, not dropping the work', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup', session_id: 'sess-1' }),
      );

      // The student typed this prompt and Claude replied, but the live
      // `user-prompt` hook never fired for it (the two hooks can desync). The
      // transcript still holds it, in-window (timestamp after session start), so
      // Stop must back-fill the prompt and attach its reply — never drop it.
      const ts = new Date(Date.now() + 5000).toISOString();
      const lines = [
        {
          type: 'user',
          uuid: 'work-u',
          promptSource: 'typed',
          sessionId: 'sess-1',
          cwd: dir,
          timestamp: ts,
          message: { role: 'user', content: 'add a retry to the fetch helper' },
        },
        {
          type: 'assistant',
          uuid: 'work-a',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Added retry logic to fetchHelper.' }],
          },
        },
      ];
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({ cwd: dir, transcript_path: transcriptPath }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);

      expect(data.turns.length).toBe(1);
      const turn = data.turns[0];
      expect(turn.prompt.text).toBe('add a retry to the fetch helper');
      expect(turn.aiOutputs.map((o: any) => o.text)).toEqual([
        'Added retry logic to fetchHelper.',
      ]);
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit --tool codex snapshots a file from an apply_patch envelope', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'parser.ts'), 'export const x = 1;');
      const payload = JSON.stringify({
        cwd: dir,
        tool_name: 'apply_patch',
        tool_input: {
          input: '*** Begin Patch\n*** Update File: parser.ts\n@@\n-1\n+2\n*** End Patch',
        },
      });
      const r = run(dir, ['hook', 'post-edit', '--tool', 'codex'], payload);
      expect(r.code).toBe(0);
      const trace = run(dir, ['trace', 'parser.ts', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
      expect(data.artifacts[0].tool).toBe('codex');
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit --tool gemini-cli snapshots the edited file (new plugin, no core change)', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      writeFileSync(join(dir, 'svc.ts'), 'export const x = 1;');
      const payload = JSON.stringify({
        cwd: dir,
        tool_name: 'write_file',
        tool_input: { file_path: join(dir, 'svc.ts'), content: 'export const x = 2;' },
      });
      const r = run(dir, ['hook', 'post-edit', '--tool', 'gemini-cli'], payload);
      expect(r.code).toBe(0);
      const trace = run(dir, ['trace', 'svc.ts', '--format', 'json']);
      const data = JSON.parse(trace.stdout);
      expect(data.artifacts.length).toBe(1);
      expect(data.artifacts[0].tool).toBe('gemini-cli');
    } finally {
      cleanup(dir);
    }
  });

  test('user-prompt --tool gemini-cli tags the prompt as gemini-cli', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const payload = JSON.stringify({ cwd: dir, prompt: 'add a cache layer' });
      const r = run(dir, ['hook', 'user-prompt', '--tool', 'gemini-cli'], payload);
      expect(r.code).toBe(0);
      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.turns[0].prompt.tool).toBe('gemini-cli');
    } finally {
      cleanup(dir);
    }
  });

  test('two interleaved Claude sessions keep separate trails', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      // Two Claude sessions start and each gets a prompt, interleaved.
      run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir, session_id: 'sA' }));
      run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir, session_id: 'sB' }));
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'task A', session_id: 'sA' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'task B', session_id: 'sB' }),
      );

      const tA = writeTranscript(dir, 'a.jsonl', [
        userLine('a-u', 'task A', dir, 'sA'),
        asstLine('a-a', 'reply A'),
      ]);
      const tB = writeTranscript(dir, 'b.jsonl', [
        userLine('b-u', 'task B', dir, 'sB'),
        asstLine('b-a', 'reply B'),
      ]);
      run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir, transcript_path: tA }));
      run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir, transcript_path: tB }));

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const a = data.turns.find((t: any) => t.prompt.text === 'task A');
      const b = data.turns.find((t: any) => t.prompt.text === 'task B');
      // Each reply lands under its own session's prompt — neither blank, no cross-talk.
      expect(a.aiOutputs.map((o: any) => o.text)).toEqual(['reply A']);
      expect(b.aiOutputs.map((o: any) => o.text)).toEqual(['reply B']);
    } finally {
      cleanup(dir);
    }
  });

  test('stop on an older session after a newer one started still captures its reply', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      // The exact regression: a prompt is logged in session "old", then a newer
      // session "new" starts (advancing the global current pointer). The old
      // session's Stop must still attribute its reply to the old prompt — not
      // drop it as "backlog" against the newer session's start time.
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, session_id: 'old' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'old session task', session_id: 'old' }),
      );
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, session_id: 'new' }),
      );

      const tOld = writeTranscript(dir, 'old.jsonl', [
        userLine('old-u', 'old session task', dir, 'old'),
        asstLine('old-a', 'old reply applied'),
      ]);
      run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir, transcript_path: tOld }));

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const turn = data.turns.find((t: any) => t.prompt.text === 'old session task');
      expect(turn.aiOutputs.map((o: any) => o.text)).toEqual(['old reply applied']);
    } finally {
      cleanup(dir);
    }
  });

  test('stop recovers a reply for a prompt whose session was closed before the turn', () => {
    // The session-close race: a prompt is logged live into session S for native
    // session N; S is then closed (here via session-end, the deterministic stand-in
    // for the idle sweep) before the turn's Stop. The Stop resolves a *fresh*
    // session S' for N, so the prompt is no longer in the resolved session and its
    // transcript line predates S'. Without the cross-session recovery the reply is
    // dropped as backlog; with it, the reply attaches to the original prompt.
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir, session_id: 'N' }));
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'orphan task', session_id: 'N' }),
      );
      // Close S. The next Stop for N will create a new session S'.
      run(dir, ['hook', 'session-end'], JSON.stringify({ cwd: dir, session_id: 'N' }));

      // The prompt's transcript line carries a past timestamp, so it predates S'
      // and would trip the backlog guard if matched only against S'.
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = writeTranscript(dir, 'orphan.jsonl', [
        userLineWithSource('orphan-u', 'orphan task', dir, 'typed', {
          sessionId: 'N',
          timestamp: past,
        }),
        asstLine('orphan-a', 'orphan reply recovered'),
      ]);
      run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir, transcript_path: t }));

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      // Exactly one prompt (matched its closed sibling — not duplicated as a
      // back-fill), and its reply was recovered rather than dropped.
      expect(data.turns.length).toBe(1);
      const turn = data.turns.find((t: any) => t.prompt.text === 'orphan task');
      expect(turn.aiOutputs.map((o: any) => o.text)).toEqual(['orphan reply recovered']);

      // And the diagnostic log records that the recovery fired.
      const trace = readFileSync(join(dir, '.showtail', 'diag', 'hooks.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const stop = trace.find((e: any) => e.event === 'stop');
      expect(stop.recoveredReplies).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('session-start binds one Showtail session per Claude session_id (no churn)', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      const ss = (id: string) =>
        run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir, session_id: id }));
      ss('sX'); // first time: creates one
      ss('sY'); // a different id: creates a second
      ss('sX'); // repeat (e.g. resume/compact): must NOT create a third

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.summary.sessions).toBe(2);
    } finally {
      cleanup(dir);
    }
  });

  test('falls back to the current session when no session_id is present', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      // No session_id anywhere and no sessionId in the transcript (older client).
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'fallback task' }),
      );
      const t = writeTranscript(dir, 'f.jsonl', [
        userLine('f-u', 'fallback task', dir, null),
        asstLine('f-a', 'fallback reply'),
      ]);
      run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir, transcript_path: t }));

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      expect(data.turns.length).toBe(1);
      expect(data.turns[0].prompt.text).toBe('fallback task');
      expect(data.turns[0].aiOutputs.map((o: any) => o.text)).toEqual(['fallback reply']);
    } finally {
      cleanup(dir);
    }
  });

  test('post-edit attaches to the open turn of its own Claude session', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      // Two concurrent sessions each open a turn; an edit tagged to session A
      // must attach to A's prompt, not B's (the most recent global turn).
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'task A', session_id: 'sA' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'task B', session_id: 'sB' }),
      );
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
      run(
        dir,
        ['hook', 'post-edit'],
        JSON.stringify({
          cwd: dir,
          session_id: 'sA',
          tool_name: 'Edit',
          tool_input: { file_path: join(dir, 'a.ts') },
        }),
      );

      run(dir, ['report', '--format', 'json']);
      const data = readJsonReport(dir);
      const a = data.turns.find((t: any) => t.prompt.text === 'task A');
      const b = data.turns.find((t: any) => t.prompt.text === 'task B');
      expect(a.codeChanges.length).toBe(1);
      expect(b.codeChanges.length).toBe(0);
    } finally {
      cleanup(dir);
    }
  });
});

describe('isInternalPath', () => {
  test('skips the tools own bookkeeping dirs', () => {
    expect(isInternalPath('C:\\Users\\me\\proj\\.showtail\\state.json')).toBe(true);
    expect(isInternalPath('/home/me/proj/.claude/settings.json')).toBe(true);
    expect(isInternalPath('/home/me/.codex/config.toml')).toBe(true);
  });

  test('captures code edited inside a .claude/worktrees/ checkout', () => {
    // Real work happens in these isolated checkouts — they must not be skipped.
    expect(
      isInternalPath(
        'C:\\Users\\me\\proj\\.claude\\worktrees\\feature-x\\src\\core\\report.ts',
      ),
    ).toBe(false);
    expect(isInternalPath('/home/me/proj/.claude/worktrees/wt/src/foo.ts')).toBe(false);
  });

  test('does not skip ordinary project files', () => {
    expect(isInternalPath('/home/me/proj/src/foo.ts')).toBe(false);
    expect(isInternalPath('C:\\Users\\me\\proj\\src\\foo.ts')).toBe(false);
  });
});

describe('hook trace (diagnostic log)', () => {
  /** Read the parsed records from .showtail/diag/hooks.jsonl, oldest first. */
  function readTrace(dir: string): any[] {
    const file = join(dir, '.showtail', 'diag', 'hooks.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  test('records each hook invocation with its session, source, and stop counts', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      run(
        dir,
        ['hook', 'session-start'],
        JSON.stringify({ cwd: dir, source: 'startup', session_id: 'sess-1' }),
      );
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({
          cwd: dir,
          prompt: 'do the thing',
          session_id: 'sess-1',
          promptSource: 'suggestion_accepted',
        }),
      );
      const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
        userLine('u1', 'do the thing', dir),
        asstLine('a1', 'done the thing'),
      ]);
      run(
        dir,
        ['hook', 'stop'],
        JSON.stringify({
          cwd: dir,
          transcript_path: transcriptPath,
          session_id: 'sess-1',
        }),
      );

      const trace = readTrace(dir);
      const byEvent = (e: string) => trace.find((t) => t.event === e);

      // Every invocation is recorded, stamped, and timed.
      expect(byEvent('session-start')).toBeDefined();
      for (const t of trace) {
        expect(typeof t.ts).toBe('string');
        expect(typeof t.durationMs).toBe('number');
      }

      // The user-prompt trace carries the source and the turn it opened.
      const up = byEvent('user-prompt');
      expect(up.promptSource).toBe('suggestion_accepted');
      expect(typeof up.promptId).toBe('string');
      expect(up.sessionId).toBeTruthy();

      // The stop trace reports what the reconcile captured.
      const stop = byEvent('stop');
      expect(stop.replies).toBe(1);
      expect(stop.sessionId).toBe(up.sessionId); // same Showtail session
    } finally {
      cleanup(dir);
    }
  });

  test('can be disabled with SHOWTAIL_HOOK_TRACE=0', () => {
    const dir = makeTempDir();
    try {
      initProject(dir);
      runCli(dir, ['hook', 'user-prompt'], {
        input: JSON.stringify({
          cwd: dir,
          prompt: 'no trace please',
          session_id: 'sess-1',
        }),
        env: { ...spawnEnv(), SHOWTAIL_HOOK_TRACE: '0' },
      });
      expect(existsSync(join(dir, '.showtail', 'diag', 'hooks.jsonl'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
