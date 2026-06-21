import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir, seedAuthor, spawnEnv, TEST_EMAIL } from './helpers.ts';
import { ensureInitialized } from '../src/commands/init.ts';
import { logEvent, sweepIdleSessions } from '../src/core/events.ts';
import { readSessions } from '../src/core/storage.ts';

const HOUR = 60 * 60 * 1000;
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function run(cwd: string, args: string[], input = '') {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: spawnEnv(),
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

describe('automatic session lifecycle', () => {
  test('idle sweep closes a stale session, stamped at its last event (not now)', async () => {
    const dir = makeTempDir();
    try {
      const { paths } = await ensureInitialized(dir);
      const author = seedAuthor(paths, TEST_EMAIL);
      const { event, session } = await logEvent(author, {
        type: 'prompt',
        text: 'old work',
        tool: 'cli',
      });
      // Pretend "now" is two hours past the last event — beyond the 1h window.
      const now = Date.parse(event.timestamp) + 2 * HOUR;
      const closed = sweepIdleSessions(author, HOUR, now);

      expect(closed).toContain(session.id);
      const stored = readSessions(author).find((s) => s.id === session.id)!;
      expect(stored.endedAt).toBe(event.timestamp);
    } finally {
      cleanup(dir);
    }
  });

  test('a session with recent activity is left open', async () => {
    const dir = makeTempDir();
    try {
      const { paths } = await ensureInitialized(dir);
      const author = seedAuthor(paths, TEST_EMAIL);
      const { session } = await logEvent(author, {
        type: 'prompt',
        text: 'recent work',
        tool: 'cli',
      });
      const closed = sweepIdleSessions(author, HOUR, Date.now());

      expect(closed).not.toContain(session.id);
      expect(
        readSessions(author).find((s) => s.id === session.id)!.endedAt,
      ).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  test('SessionEnd closes the bound session deterministically', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');
      run(dir, ['init']);
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'hi', session_id: 's1' }),
      );

      const before = JSON.parse(run(dir, ['sessions', '--json']).stdout);
      expect(before.some((s: { endedAt: string | null }) => s.endedAt)).toBe(false);

      run(dir, ['hook', 'session-end'], JSON.stringify({ cwd: dir, session_id: 's1' }));

      const after = JSON.parse(run(dir, ['sessions', '--json']).stdout);
      const closed = after.filter((s: { endedAt: string | null }) => s.endedAt);
      expect(closed.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('after a session is closed, the same tool session_id opens a fresh one', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}\n');
      run(dir, ['init']);
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'first', session_id: 's1' }),
      );
      run(dir, ['hook', 'session-end'], JSON.stringify({ cwd: dir, session_id: 's1' }));
      // A later prompt on the same Claude session is a new task → new session.
      run(
        dir,
        ['hook', 'user-prompt'],
        JSON.stringify({ cwd: dir, prompt: 'second', session_id: 's1' }),
      );

      const sessions = JSON.parse(run(dir, ['sessions', '--json']).stdout);
      expect(sessions.length).toBe(2);
      expect(sessions.filter((s: { endedAt: string | null }) => !s.endedAt).length).toBe(
        1,
      );
    } finally {
      cleanup(dir);
    }
  });
});
