import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { readAllEvents } from '../src/core/events.ts';
import {
  allLedgerSessions,
  appendLedgerRecord,
  ensureLedgerSession,
  readLedgerRecords,
} from '../src/core/ledger.ts';
import { materializeLedgerSession } from '../src/core/materialize.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import {
  authorFor,
  cleanup,
  enableAutoInit,
  envWithHome,
  makeTempDir,
  runCli,
} from './helpers.ts';

// In-process ledger reads/writes resolve SHOWTAIL_HOME live; each test points it
// at a throwaway dir and restores the previous value after.
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('projection parity foundation (gitCommit + sha256)', () => {
  test('materialize carries a record’s gitCommit and sha256 into the trail', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);

      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's1',
        cwd: dir,
      });
      const p = appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'do the work',
        gitCommit: 'abc1234',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: join(dir, 'f.ts'),
        diff: '+ const x = 1;',
        sha256: 'deadbeefhash',
        gitCommit: 'abc1234',
        turnKey: p.id,
      });

      await materializeLedgerSession(session, author);

      const prompt = readAllEvents(paths).find((e) => e.type === 'prompt');
      expect(prompt?.gitCommit).toBe('abc1234');

      const art = readAllArtifacts(paths).find((a) => a.diffHash);
      expect(art?.sha256).toBe('deadbeefhash');
      expect(art?.gitCommit).toBe('abc1234');
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('captureToLedger records the live commit + file hash in a git repo', () => {
    const home = makeTempDir();
    const repo = makeTempDir();
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 'ci@example.com');
      git(repo, 'config', 'user.name', 'CI');
      writeFileSync(join(repo, 'package.json'), '{}\n'); // eligible dev folder
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'init');
      const head = git(repo, 'rev-parse', 'HEAD');

      enableAutoInit(home);
      const env = envWithHome(home);

      runCli(repo, ['hook', 'user-prompt'], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: repo,
          prompt: 'edit the parser',
          session_id: 's1',
        }),
        env,
      });
      writeFileSync(join(repo, 'parser.ts'), 'export const x = 1;\n');
      runCli(repo, ['hook', 'post-edit'], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          cwd: repo,
          session_id: 's1',
          tool_name: 'Edit',
          tool_input: {
            file_path: join(repo, 'parser.ts'),
            old_string: 'a',
            new_string: 'b',
          },
        }),
        env,
      });

      // Inspect the ledger the spawned CLI wrote into.
      process.env.SHOWTAIL_HOME = home;
      const session = allLedgerSessions()[0]!;
      const recs = readLedgerRecords(session.id);
      const prompt = recs.find((r) => r.kind === 'prompt');
      const edit = recs.find((r) => r.kind === 'edit');
      expect(prompt?.gitCommit).toBe(head);
      expect(edit?.gitCommit).toBe(head);
      expect(edit?.sha256).toBeTruthy();
    } finally {
      cleanup(repo);
      cleanup(home);
    }
  });
});
