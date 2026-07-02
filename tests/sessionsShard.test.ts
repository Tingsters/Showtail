import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { logEvent } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import { authorPaths, pathsForRoot, readSessions } from '../src/core/storage.ts';
import { cleanup, makeTempDir, seedAuthor } from './helpers.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('sessions are machine-sharded (CC1)', () => {
  test('the same author on two machines writes disjoint session shards', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      seedAuthor(paths, 'dev@x.com'); // creates the author folder
      const slug = 'dev-at-x-com';

      // Two views of the SAME author, on two different machines.
      const m1 = authorPaths(paths, slug, 'machine-1111');
      const m2 = authorPaths(paths, slug, 'machine-2222');

      const s1 = startSession(m1);
      await logEvent(m1, { type: 'prompt', text: 'work on machine 1', sessionId: s1.id });
      const s2 = startSession(m2);
      await logEvent(m2, { type: 'prompt', text: 'work on machine 2', sessionId: s2.id });

      // Each machine wrote ONLY its own shard file — no shared file to conflict on.
      expect(existsSync(join(m1.sessionsDir, 'machine-1111.json'))).toBe(true);
      expect(existsSync(join(m2.sessionsDir, 'machine-2222.json'))).toBe(true);
      // The legacy single sessions.json is never written.
      expect(existsSync(m1.sessionsIndex)).toBe(false);

      // A read aggregates both shards into one union (machineId stamped on each).
      const all = readSessions(authorPaths(paths, slug));
      expect(all.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
      expect(all.find((s) => s.id === s1.id)?.machineId).toBe('machine-1111');
      expect(all.find((s) => s.id === s2.id)?.machineId).toBe('machine-2222');
    } finally {
      cleanup(dir);
    }
  });

  test('two machines (same author) merge their committed session shards with no conflict', async () => {
    const dir = makeTempDir();
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.email', 'ci@example.com');
      git(dir, 'config', 'user.name', 'CI');

      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      seedAuthor(paths, 'dev@x.com');
      const slug = 'dev-at-x-com';
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init + author');

      // Machine 1 commits its shard on its own branch.
      git(dir, 'checkout', '-b', 'm1');
      const m1 = authorPaths(paths, slug, 'machine-1111');
      const s1 = startSession(m1);
      await logEvent(m1, { type: 'prompt', text: 'm1 work', sessionId: s1.id });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'm1 trail');

      // Machine 2 branches from the shared base and commits its own shard.
      git(dir, 'checkout', 'main');
      git(dir, 'checkout', '-b', 'm2');
      const m2 = authorPaths(paths, slug, 'machine-2222');
      const s2 = startSession(m2);
      await logEvent(m2, { type: 'prompt', text: 'm2 work', sessionId: s2.id });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'm2 trail');

      // The SAME author from two machines must merge without conflict.
      git(dir, 'checkout', 'm1');
      expect(() => git(dir, 'merge', 'm2', '--no-edit')).not.toThrow();

      // Both sessions survive the merge.
      const all = readSessions(authorPaths(paths, slug)).map((s) => s.id);
      expect(all).toContain(s1.id);
      expect(all).toContain(s2.id);
    } finally {
      cleanup(dir);
    }
  });
});
