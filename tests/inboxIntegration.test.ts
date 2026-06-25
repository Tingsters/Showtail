import { describe, expect, test } from 'bun:test';
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
  test('status --json reports the count of unplaced sessions', () => {
    const repo = makeTempDir();
    const scratch = makeTempDir();
    const home = makeTempDir();
    try {
      enableAutoInit(home);
      const env = envWithHome(home);

      // A folderless capture → lands in the inbox (unplaced).
      runCli(scratch, ['hook', 'user-prompt'], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: scratch,
          prompt: 'scratch work',
          session_id: 's1',
        }),
        env,
      });
      // A placed capture in an initialized project (so `status` has somewhere to run).
      runCli(repo, ['init', '--project', 'Demo'], { env });

      const status = JSON.parse(runCli(repo, ['status', '--json'], { env }).stdout);
      expect(status.inbox).toBe(1);
    } finally {
      cleanup(repo);
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
