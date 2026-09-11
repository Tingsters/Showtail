/**
 * Catch-up sweep: recovering the part of a session the live hooks could not see.
 *
 * Hosts write their transcript asynchronously ("may lag current turn") and
 * append the end-of-turn recap minutes after the last hook has run — so a
 * session's final exchange is invisible at Stop time and has no later Stop to
 * heal it. `showtail report` re-reads the transcript first; these tests drive
 * that through the real CLI, with a transcript that grows *after* the hooks ran.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import {
  allLedgerSessions,
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerRecords,
  setLedgerTranscriptPath,
} from '../src/core/ledger.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import {
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  readJsonReport,
  runCli,
} from './helpers.ts';

const run = (cwd: string, args: string[], input?: string) => runCli(cwd, args, { input });

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});
function tmp(): string {
  const d = makeTempDir();
  dirs.push(d);
  return d;
}

function withShowtailHome<T>(home: string, action: () => T): T {
  const previous = process.env.SHOWTAIL_HOME;
  process.env.SHOWTAIL_HOME = home;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = previous;
  }
}

/** The turn as the Stop hook sees it: the host hasn't written the ending yet. */
function laggingTranscript(cwd: string): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-15T10:00:00.000Z',
        promptSource: 'typed',
        sessionId: 'sess-catchup',
        cwd,
        message: { role: 'user', content: 'make it a top down game' },
      },
      // The turn launches the game in the background…
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-15T10:00:10.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 200 },
          content: [
            {
              type: 'tool_use',
              id: 'tb1',
              name: 'Bash',
              input: { command: 'cd ~/cat_game && python3 main.py' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1b',
        timestamp: '2026-08-15T10:00:12.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tb1',
              content: 'Command running in background with ID: br76pb576.',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a1b',
        timestamp: '2026-08-15T10:00:15.000Z',
        message: {
          id: 'msg_1b',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 30 },
          content: [{ type: 'text', text: "I've rewritten it as a top-down game." }],
        },
      },
      // The Stop fires here: a duration, but the recap does not exist yet —
      // and the backgrounded command has not finished either.
      {
        type: 'system',
        uuid: 's1',
        subtype: 'turn_duration',
        durationMs: 104954,
        timestamp: '2026-08-15T10:00:16.000Z',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

/** The same turn once the host has caught up: closing message + recap appended. */
function completedTranscript(cwd: string): string {
  return (
    laggingTranscript(cwd) +
    [
      // A backgrounded task finished — a synthetic, system-sourced line that
      // must not open a turn of its own.
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-15T10:00:50.000Z',
        promptSource: 'system',
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content:
            '<task-notification>\n<tool-use-id>tb1</tool-use-id>\n<status>completed</status>\n' +
            '<summary>Background command "Launch the game" completed (exit code 0)</summary>\n' +
            '</task-notification>',
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-08-15T10:00:52.000Z',
        message: {
          id: 'msg_2',
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2, output_tokens: 90 },
          content: [{ type: 'text', text: 'The game window closed cleanly.' }],
        },
      },
      {
        type: 'system',
        uuid: 's2',
        subtype: 'turn_duration',
        durationMs: 2292,
        timestamp: '2026-08-15T10:00:53.000Z',
      },
      {
        type: 'system',
        uuid: 's3',
        subtype: 'away_summary',
        content: 'Built a top-down cat game; it ran and closed cleanly.',
        timestamp: '2026-08-15T10:03:55.000Z',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') +
    '\n'
  );
}

/** Content written after an explicit reconnect boundary. */
function resumedTranscript(cwd: string): string {
  return (
    completedTranscript(cwd) +
    JSON.stringify({
      type: 'assistant',
      uuid: 'a3',
      timestamp: '2026-08-15T10:04:10.000Z',
      message: {
        id: 'msg_3',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'This response was produced after reconnect.' }],
      },
    }) +
    '\n'
  );
}

/** A transcript update that reveals an edit in a second project after Stop. */
function transcriptWithOutsideEdit(cwd: string, file: string): string {
  return (
    completedTranscript(cwd) +
    JSON.stringify({
      type: 'assistant',
      uuid: 'outside-edit-message',
      timestamp: '2026-08-15T10:04:00.000Z',
      message: {
        id: 'msg_outside_edit',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id: 'outside-edit',
            name: 'Edit',
            input: { file_path: file, old_string: '1', new_string: '2' },
          },
        ],
      },
    }) +
    '\n'
  );
}

/** Track a project and drive one prompt + Stop against a lagging transcript. */
function seedLaggingSession(dir: string): string {
  const transcript = join(dir, 't.jsonl');
  run(dir, ['track', '--project', 'Catchup']);
  run(
    dir,
    ['hook', 'user-prompt'],
    JSON.stringify({
      cwd: dir,
      prompt: 'make it a top down game',
      session_id: 'sess-catchup',
    }),
  );
  writeFileSync(transcript, laggingTranscript(dir));
  run(
    dir,
    ['hook', 'stop'],
    JSON.stringify({ cwd: dir, session_id: 'sess-catchup', transcript_path: transcript }),
  );
  return transcript;
}

/** Start the same lagging session through hooks; the environment decides auto-init. */
function seedHookLaggingSession(dir: string, env: NodeJS.ProcessEnv): string {
  const transcript = join(dir, 't.jsonl');
  runCli(dir, ['hook', 'user-prompt'], {
    input: JSON.stringify({
      cwd: dir,
      prompt: 'make it a top down game',
      session_id: 'sess-catchup',
    }),
    env,
  });
  writeFileSync(transcript, laggingTranscript(dir));
  runCli(dir, ['hook', 'stop'], {
    input: JSON.stringify({
      cwd: dir,
      session_id: 'sess-catchup',
      transcript_path: transcript,
    }),
    env,
  });
  return transcript;
}

describe('report catch-up sweep', () => {
  test('recovers the closing message and recap the hooks never saw', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);

    // Before: the Stop only ever saw the lagging file.
    run(dir, ['report', '--format', 'json', '--no-sync']);
    const before = readJsonReport(dir);
    const beforeTexts = before.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(beforeTexts).not.toContain('The game window closed cleanly.');
    expect(before.turns[0].recap?.text ?? '').toBe('');

    // The host catches up — no further hook ever runs.
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json']);
    const after = readJsonReport(dir);
    const afterTexts = after.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(afterTexts).toContain('The game window closed cleanly.');
    expect(after.turns[0].recap.text).toBe(
      'Built a top-down cat game; it ran and closed cleanly.',
    );
    // Still a single turn — the task-notification never opened one.
    expect(after.turns.length).toBe(1);

    // The background command's launch AND how it finished are both shown.
    const calls = after.turns[0].toolCalls;
    expect(calls.map((c: { toolName: string }) => c.toolName)).toEqual([
      'Bash',
      'Background task',
    ]);
    expect(calls[1].text).toBe(
      'Background command "Launch the game" completed (exit code 0)',
    );
  });

  test('does not catch up transcript content after a global tool disconnect', () => {
    const dir = tmp();
    const home = tmp();
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(dir, env);

    // The host appends content after the final hook, then the student globally
    // disconnects this tool before asking for a report.
    writeFileSync(transcript, completedTranscript(dir));
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 1,
        autoInit: true,
        captureDisabledTools: ['claude'],
      }),
    );

    expect(runCli(dir, ['report', '--format', 'json'], { env }).code).toBe(0);
    const report = readJsonReport(dir);
    const output = report.turns[0].aiOutputs.map((event: { text: string }) => event.text);
    expect(output).not.toContain('The game window closed cleanly.');
    expect(report.turns[0].recap?.text ?? '').toBe('');
  });

  test('after reconnect, catch-up excludes the disabled interval and keeps new work', () => {
    const dir = tmp();
    const home = tmp();
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(dir, env);

    // The closing response and recap were written while capture was stopped.
    // Only the final response is later than the explicit reconnect boundary.
    writeFileSync(transcript, resumedTranscript(dir));
    const consentDir = join(home, 'capture-consent');
    mkdirSync(consentDir, { recursive: true });
    writeFileSync(
      join(consentDir, 'tool-claude.json'),
      JSON.stringify({
        version: 1,
        tool: 'claude',
        capture: 'enabled',
        enabledAt: '2026-08-15T10:04:00.000Z',
      }),
      'utf8',
    );

    expect(runCli(dir, ['report', '--format', 'json'], { env }).code).toBe(0);
    const report = readJsonReport(dir);
    const output = report.turns[0].aiOutputs.map((event: { text: string }) => event.text);
    expect(output).not.toContain('The game window closed cleanly.');
    expect(report.turns[0].recap?.text ?? '').toBe('');
    expect(output).toContain('This response was produced after reconnect.');
  });

  test('an explicit duplicate-trail path cannot sweep the session placed in the other copy', () => {
    const workspace = tmp();
    const home = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(first, env);
    withShowtailHome(home, () => {
      const session = allLedgerSessions().find(
        (candidate) => candidate.nativeSessionId === 'sess-catchup',
      );
      if (!session) throw new Error('Missing catch-up ledger session');
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'keep this later turn with the original copy',
        context: { cwd: first, workspacePaths: [first], scope: 'session' },
      });
    });

    // The copied project carries the same trail id, but the ledger placement
    // still records the original root as its path witness.
    cpSync(join(first, '.showtail'), join(second, '.showtail'), { recursive: true });
    writeFileSync(transcript, completedTranscript(first));

    const before = withShowtailHome(home, () => {
      const session = allLedgerSessions().find(
        (candidate) => candidate.nativeSessionId === 'sess-catchup',
      );
      if (!session) throw new Error('Missing catch-up ledger session');
      return {
        id: session.id,
        targets: structuredClone(session.targets ?? []),
        records: readLedgerRecords(session.id),
      };
    });
    const eventsBefore = readAllEvents(pathsForRoot(first));

    const command = runCli(
      second,
      ['report', '--project', second, '--json', '--no-open'],
      { env },
    );
    expect(command.code).toBe(0);
    expect(command.stderr).toBe('');
    expect(JSON.parse(command.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        root: resolve(second),
        reportPath: expect.stringContaining(join(second, '.showtail', 'reports')),
      }),
    );

    const after = withShowtailHome(home, () => {
      const session = allLedgerSessions().find((candidate) => candidate.id === before.id);
      if (!session) throw new Error('Catch-up ledger session was removed');
      return {
        targets: session.targets ?? [],
        records: readLedgerRecords(session.id),
      };
    });
    expect(after.targets).toEqual(before.targets);
    expect(after.records).toEqual(before.records);
    expect(readAllEvents(pathsForRoot(first))).toEqual(eventsBefore);
    expect(readdirSync(join(first, '.showtail', 'reports'))).toEqual([]);
    expect(readdirSync(join(second, '.showtail', 'reports')).length).toBeGreaterThan(0);
  });

  test('stops the report and parks the session when catch-up becomes ambiguous', () => {
    const workspace = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    const transcript = seedLaggingSession(first);

    run(
      first,
      ['hook', 'post-edit'],
      JSON.stringify({
        cwd: first,
        session_id: 'sess-catchup',
        tool_name: 'Edit',
        tool_input: { file_path: firstFile },
      }),
    );
    expect(readAllArtifacts(pathsForRoot(first)).length).toBe(1);

    // No later hook sees this edit. The report sweep is the first observer.
    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = run(first, ['report', '--format', 'json', '--json', '--verbose-json']);
    expect(report.code).toBe(2);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual(
      expect.objectContaining({
        ok: false,
        errorCode: 'AMBIGUOUS_PROJECT',
        nextAction: 'review-inbox',
        candidates: expect.arrayContaining([resolve(first), resolve(second)]),
      }),
    );

    const session = JSON.parse(run(first, ['move', '--json']).stdout).sessions.find(
      (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
    );
    expect(session).toEqual(
      expect.objectContaining({ status: 'inbox', paths: [], edits: 2 }),
    );
    expect(readAllArtifacts(pathsForRoot(first))).toEqual([]);
    expect(readdirSync(join(first, '.showtail', 'reports'))).toEqual([]);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
  });

  test('reports retained source work when one caught-up session becomes ambiguous', () => {
    const workspace = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    const transcript = seedLaggingSession(first);

    run(
      first,
      ['hook', 'post-edit'],
      JSON.stringify({
        cwd: first,
        session_id: 'sess-catchup',
        tool_name: 'Edit',
        tool_input: { file_path: firstFile },
      }),
    );
    run(
      first,
      ['hook', 'user-prompt'],
      JSON.stringify({
        cwd: first,
        prompt: 'keep this work in the first project',
        session_id: 'sess-local',
      }),
    );

    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = run(first, ['report', '--format', 'json', '--json', '--verbose-json']);
    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        root: resolve(first),
        pendingAmbiguous: [
          expect.objectContaining({
            candidates: expect.arrayContaining([resolve(first), resolve(second)]),
          }),
        ],
      }),
    );

    expect(existsSync(join(second, '.showtail'))).toBe(false);
    const sourceReport = readJsonReport(first);
    expect(sourceReport.summary.sessions).toBe(1);
    expect(
      sourceReport.turns.map((turn: { prompt: { text: string } }) => turn.prompt.text),
    ).toEqual(['keep this work in the first project']);

    const sessions = JSON.parse(run(workspace, ['move', '--json']).stdout).sessions;
    expect(
      sessions.find(
        (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
      ),
    ).toEqual(expect.objectContaining({ status: 'inbox', paths: [] }));
    expect(
      sessions.find(
        (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-local',
      ),
    ).toEqual(expect.objectContaining({ status: 'placed', paths: [resolve(first)] }));
  });

  test('redirects a report when catch-up resolves a provisional trail to one other project', () => {
    const workspace = tmp();
    const home = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const secondFile = join(second, 'two.ts');
    writeFileSync(secondFile, 'export const two = 2;\n');
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(first, env);

    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = runCli(
      first,
      ['report', '--format', 'json', '--json', '--verbose-json'],
      { env },
    );
    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual(
      expect.objectContaining({ ok: true, root: resolve(second) }),
    );

    // Segmented cleanup keeps the automatic shell so a concurrent turn cannot
    // race with whole-directory pruning, but the rerouted work must be gone.
    expect(existsSync(join(first, '.showtail', 'config.json'))).toBe(true);
    expect(readAllEvents(pathsForRoot(first))).toHaveLength(0);
    expect(readAllArtifacts(pathsForRoot(first))).toHaveLength(0);
    expect(readdirSync(join(first, '.showtail', 'reports'))).toEqual([]);
    expect(existsSync(join(second, '.showtail', 'config.json'))).toBe(true);
    expect(readJsonReport(second).turns[0].prompt.text).toBe('make it a top down game');
    expect(
      readAllArtifacts(pathsForRoot(second)).map((artifact) => artifact.path),
    ).toContain('two.ts');
    const session = JSON.parse(
      runCli(workspace, ['move', '--json'], { env }).stdout,
    ).sessions.find(
      (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
    );
    expect(session).toEqual(
      expect.objectContaining({ status: 'placed', paths: [resolve(second)] }),
    );
  });

  test('reports retained source work when one caught-up session reroutes', () => {
    const workspace = tmp();
    const home = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const secondFile = join(second, 'two.ts');
    writeFileSync(secondFile, 'export const two = 2;\n');
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(first, env);

    // This independent session genuinely belongs to the requested source trail.
    runCli(first, ['hook', 'user-prompt'], {
      input: JSON.stringify({
        cwd: first,
        prompt: 'keep this work in the first project',
        session_id: 'sess-local',
      }),
      env,
    });

    // Only the earlier session gains stronger evidence for the second project.
    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = runCli(
      first,
      ['report', '--format', 'json', '--json', '--verbose-json'],
      { env },
    );
    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        root: resolve(first),
        reroutedSessions: [expect.objectContaining({ root: resolve(second) })],
      }),
    );

    expect(existsSync(join(second, '.showtail'))).toBe(false);
    const sourceReport = readJsonReport(first);
    expect(sourceReport.summary.sessions).toBe(1);
    expect(
      sourceReport.turns.map((turn: { prompt: { text: string } }) => turn.prompt.text),
    ).toEqual(['keep this work in the first project']);

    const sessions = JSON.parse(
      runCli(workspace, ['move', '--json'], { env }).stdout,
    ).sessions;
    expect(
      sessions.find(
        (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
      ),
    ).toEqual(expect.objectContaining({ status: 'inbox', paths: [] }));
    expect(
      sessions.find(
        (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-local',
      ),
    ).toEqual(expect.objectContaining({ status: 'placed', paths: [resolve(first)] }));
  });

  test('redirects a report-created trail even when the source cannot be pruned', () => {
    const workspace = tmp();
    const home = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const secondFile = join(second, 'two.ts');
    writeFileSync(secondFile, 'export const two = 2;\n');
    const env = envWithHome(home);
    const transcript = join(first, 't.jsonl');
    writeFileSync(transcript, laggingTranscript(first));
    let ledgerId = '';
    const previousHome = process.env.SHOWTAIL_HOME;
    process.env.SHOWTAIL_HOME = home;
    try {
      const ledger = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'sess-catchup',
        cwd: first,
      });
      ledgerId = ledger.id;
      appendLedgerRecord(ledger.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'make it a top down game',
      });
      setLedgerTranscriptPath(ledger.id, transcript);
    } finally {
      if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previousHome;
    }
    expect(existsSync(join(first, '.showtail'))).toBe(false);

    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = runCli(
      first,
      ['report', '--format', 'json', '--json', '--verbose-json'],
      { env },
    );
    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    const payload = JSON.parse(report.stdout);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        root: resolve(second),
        claimedSessions: [ledgerId],
      }),
    );
    expect(existsSync(join(first, '.showtail', 'config.json'))).toBe(true);
    expect(readdirSync(join(first, '.showtail', 'reports'))).toEqual([]);
    expect(existsSync(join(second, '.showtail', 'config.json'))).toBe(true);
    expect(readJsonReport(second).turns[0].prompt.text).toBe('make it a top down game');
    expect(
      readAllArtifacts(pathsForRoot(second)).map((artifact) => artifact.path),
    ).toContain('two.ts');

    const session = JSON.parse(
      runCli(workspace, ['move', '--json'], { env }).stdout,
    ).sessions.find(
      (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
    );
    expect(session).toEqual(
      expect.objectContaining({ status: 'placed', paths: [resolve(second)] }),
    );
  });

  test('stops cleanly when catch-up prunes a provisional trail that becomes ambiguous', () => {
    const workspace = tmp();
    const home = tmp();
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    const firstFile = join(first, 'one.ts');
    const secondFile = join(second, 'two.ts');
    writeFileSync(firstFile, 'export const one = 1;\n');
    writeFileSync(secondFile, 'export const two = 2;\n');
    enableAutoInit(home);
    const env = envWithHome(home);
    const transcript = seedHookLaggingSession(first, env);
    runCli(first, ['hook', 'post-edit'], {
      input: JSON.stringify({
        cwd: first,
        session_id: 'sess-catchup',
        tool_name: 'Edit',
        tool_input: { file_path: firstFile },
      }),
      env,
    });

    writeFileSync(transcript, transcriptWithOutsideEdit(first, secondFile));
    const report = runCli(first, ['report', '--format', 'json', '--json'], { env });
    expect(report.code).toBe(2);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual(
      expect.objectContaining({
        ok: false,
        errorCode: 'AMBIGUOUS_PROJECT',
        nextAction: 'review-inbox',
        candidates: expect.arrayContaining([resolve(first), resolve(second)]),
      }),
    );

    // The automatic source shell stays for concurrency safety, but it must not
    // retain the ambiguous session or gain a report for work it no longer owns.
    expect(existsSync(join(first, '.showtail', 'config.json'))).toBe(true);
    expect(readAllEvents(pathsForRoot(first))).toHaveLength(0);
    expect(readAllArtifacts(pathsForRoot(first))).toHaveLength(0);
    expect(readdirSync(join(first, '.showtail', 'reports'))).toEqual([]);
    expect(existsSync(join(second, '.showtail'))).toBe(false);
    const session = JSON.parse(
      runCli(workspace, ['move', '--json'], { env }).stdout,
    ).sessions.find(
      (item: { nativeSessionId?: string }) => item.nativeSessionId === 'sess-catchup',
    );
    expect(session).toEqual(expect.objectContaining({ status: 'inbox', paths: [] }));
  });

  test('counts a turn`s duration once even when it captured a partial recap first', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));
    run(dir, ['report', '--format', 'json']);

    const data = readJsonReport(dir);
    // The partial recap (104954) and the complete one (104954 + 2292) both live
    // in the trail; the report must count only the chosen one.
    expect(data.turns[0].recap.durationMs).toBe(107246);
    expect(data.summary.stats.totalDurationMs).toBe(107246);
  });

  test('is idempotent — repeated reports add nothing', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json']);
    const first = readJsonReport(dir).summary.events;
    run(dir, ['report', '--format', 'json']);
    run(dir, ['report', '--format', 'json']);
    expect(readJsonReport(dir).summary.events).toBe(first);
  });

  test('--no-sync leaves the trail untouched', () => {
    const dir = tmp();
    const transcript = seedLaggingSession(dir);
    writeFileSync(transcript, completedTranscript(dir));

    run(dir, ['report', '--format', 'json', '--no-sync']);
    const data = readJsonReport(dir);
    const texts = data.turns[0].aiOutputs.map((e: { text: string }) => e.text);
    expect(texts).not.toContain('The game window closed cleanly.');
  });
});
