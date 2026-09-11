import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { verifyProject } from '../src/commands/verify.ts';
import { appendJournal, JOURNAL_ENTRY_VERSION } from '../src/core/journal.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import {
  authorFor,
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  runCli,
} from './helpers.ts';

describe('status surfaces the inbox (D1)', () => {
  test('status --json counts actionable ambiguous work, not already placed work', () => {
    const repo = makeTempDir(); // a tracked project — where we run `status`
    const proj = makeTempDir(); // first real project touched by one session
    const otherProj = makeTempDir(); // second project makes placement ambiguous
    const scratch = makeTempDir(); // folderless invocation cwd
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWithHome(home);
      expect(spawnSync('git', ['init'], { cwd: proj }).status).toBe(0);
      expect(spawnSync('git', ['init'], { cwd: otherProj }).status).toBe(0);

      // A folderless prompt whose edits span two projects is kept in the inbox rather
      // than guessed, but SURFACED because the work is real project work.
      runCli(scratch, ['hook', 'user-prompt'], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: scratch,
          prompt: 'real project work',
          session_id: 's1',
        }),
        env,
      });
      runCli(scratch, ['hook', 'post-edit'], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          cwd: scratch,
          session_id: 's1',
          tool_name: 'Edit',
          tool_input: { file_path: join(proj, 'a.ts'), old_string: 'x', new_string: 'y' },
        }),
        env,
      });
      runCli(scratch, ['hook', 'post-edit'], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          cwd: scratch,
          session_id: 's1',
          tool_name: 'Edit',
          tool_input: {
            file_path: join(otherProj, 'b.ts'),
            old_string: 'x',
            new_string: 'y',
          },
        }),
        env,
      });

      // A second prompt in the writable folder creates and places its own trail.
      runCli(scratch, ['hook', 'user-prompt'], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: scratch,
          prompt: 'just scratch',
          session_id: 's2',
        }),
        env,
      });

      // A tracked project to run `status` in.
      runCli(repo, ['track', '--project', 'Demo'], { env });

      const status = JSON.parse(runCli(repo, ['status', '--json'], { env }).stdout);
      // Only the ambiguous multi-project session remains in the inbox.
      expect(status.inbox).toBe(1);
    } finally {
      cleanup(repo);
      cleanup(proj);
      cleanup(otherProj);
      cleanup(scratch);
      cleanup(home);
    }
  });
});

describe('verify portability check (D4)', () => {
  test('passes on a clean trail, fails on an absolute recorded path', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      // A clean trail passes the portability check.
      const clean = await verifyProject(paths);
      const cleanCheck = clean.checks.find((c) => c.name.includes('repo-relative'))!;
      expect(cleanCheck.ok).toBe(true);

      // Inject an artifact entry with an absolute path → the check must fail.
      appendJournal(author, {
        v: JOURNAL_ENTRY_VERSION,
        kind: 'artifact',
        id: 'art_bad',
        ts: '2026-06-24T00:00:00.000Z',
        type: 'artifact',
        path: '/Users/someone/secret/evil.ts',
        sha256: 'abc123',
        actorSlug: author.slug,
      });
      const dirty = await verifyProject(paths);
      const dirtyCheck = dirty.checks.find((c) => c.name.includes('repo-relative'))!;
      expect(dirtyCheck.ok).toBe(false);
      expect(dirtyCheck.details.join('\n')).toContain('evil.ts');
      expect(dirty.ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
