import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { logEvent } from '../src/core/events.ts';
import { startSession } from '../src/core/sessions.ts';
import { authorPaths, pathsForRoot } from '../src/core/storage.ts';
import { readJournal } from '../src/core/journal.ts';
import { authorFor, cleanup, makeTempDir, seedAuthor } from './helpers.ts';

/** Recursively list files under a directory (absolute paths). */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('merge-conflict freedom', () => {
  test('two authors write to disjoint paths; identical content shares one object', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);

      const alice = seedAuthor(paths, 'alice@x.com');
      const bob = seedAuthor(paths, 'bob@x.com');

      // Both students paste the *same* boilerplate prompt.
      const sA = startSession(alice);
      const { event: aEvent } = await logEvent(alice, {
        type: 'prompt',
        text: 'shared boilerplate prompt',
        sessionId: sA.id,
      });
      const sB = startSession(bob);
      await logEvent(bob, {
        type: 'prompt',
        text: 'shared boilerplate prompt',
        sessionId: sB.id,
      });

      // Each author's journal lives under its own folder — no file is written by both.
      const aFiles = walk(alice.journalDir);
      const bFiles = walk(bob.journalDir);
      expect(aFiles.length).toBeGreaterThan(0);
      expect(bFiles.length).toBeGreaterThan(0);
      expect(aFiles.some((f) => bFiles.includes(f))).toBe(false);
      expect(alice.sessionsIndex).not.toBe(bob.sessionsIndex);

      // Identical prompt content dedups to ONE shared object (same address).
      const aRef = readJournal(alice).find((e) => e.kind === 'event')!.refs![0];
      const bRef = readJournal(bob).find((e) => e.kind === 'event')!.refs![0];
      expect(aRef).toBe(bRef);
      void aEvent;
    } finally {
      cleanup(dir);
    }
  });

  test('two students merge their committed trails through git with no conflict', async () => {
    const dir = makeTempDir();
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.email', 'ci@example.com');
      git(dir, 'config', 'user.name', 'CI');

      await runInit({ cwd: dir });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init showtail');

      const paths = pathsForRoot(dir);

      // Alice does her work on her branch and commits her .showtail trail.
      git(dir, 'checkout', '-b', 'alice');
      const alice = seedAuthor(paths, 'alice@x.com');
      const sA = startSession(alice);
      await logEvent(alice, { type: 'prompt', text: 'alice work', sessionId: sA.id });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'alice trail');

      // Bob branches from the shared init and commits his own trail.
      git(dir, 'checkout', 'main');
      git(dir, 'checkout', '-b', 'bob');
      const bob = seedAuthor(paths, 'bob@x.com');
      const sB = startSession(bob);
      await logEvent(bob, { type: 'prompt', text: 'bob work', sessionId: sB.id });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'bob trail');

      // Merging the two students' branches must NOT conflict.
      git(dir, 'checkout', 'alice');
      expect(() => git(dir, 'merge', 'bob', '--no-edit')).not.toThrow();

      // Both authors' folders survive the merge intact.
      expect(existsSync(authorPaths(paths, 'alice-at-x-com').authorFile)).toBe(true);
      expect(existsSync(authorPaths(paths, 'bob-at-x-com').authorFile)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
