import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reattachLedgerSession } from '../src/commands/reattach.ts';
import { runMove } from '../src/commands/move.ts';
import { activeAuthorPaths, ensureAuthor } from '../src/core/authors.ts';
import { readAllArtifacts } from '../src/core/artifacts.ts';
import { logEvent, readAllEvents } from '../src/core/events.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  listActionableLedgerRanges,
  readLedgerSession,
  resolveLedgerSessionId,
} from '../src/core/ledger.ts';
import {
  materializeLedgerSession,
  ProjectionOutsideRootError,
} from '../src/core/materialize.ts';
import {
  pathsForRoot,
  readSessions,
  readState,
  writeState,
} from '../src/core/storage.ts';
import { ensureInitialized } from '../src/commands/init.ts';
import { cleanup, makeTempDir } from './helpers.ts';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.SHOWTAIL_HOME;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = prev;
});

function promptTexts(root: string): string[] {
  return readAllEvents(pathsForRoot(root))
    .filter((e) => e.type === 'prompt')
    .map((e) => e.text);
}

describe('reattachLedgerSession core (place + move)', () => {
  test('places into a fresh repo, then a move lifts it out of the old one', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's1',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'movable core work',
      });

      // Place into repoA (creates the trail).
      const placed = await reattachLedgerSession(session, repoA);
      expect(placed.root).toBe(resolve(repoA));
      expect(placed.projected).toBe(1);
      expect(placed.movedFrom).toEqual([]);
      expect(promptTexts(repoA)).toContain('movable core work');
      expect(readLedgerSession(session.id)?.status).toBe('placed');

      // Move to repoB — re-read the session so its target list is current.
      const updated = resolveLedgerSessionId(session.id)!;
      const moved = await reattachLedgerSession(updated, repoB);
      expect(moved.projected).toBe(1);
      expect(moved.movedFrom.length).toBe(1); // lifted out of repoA
      expect(promptTexts(repoB)).toContain('movable core work');
      // ...and removed from repoA.
      expect(promptTexts(repoA)).not.toContain('movable core work');

      // The ledger now points only at repoB.
      const finalTargets = readLedgerSession(session.id)?.targets ?? [];
      expect(finalTargets.length).toBe(1);
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
    }
  });

  test('a move removes an old projection even after the active author changes', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'identity-upgrade',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'work recorded under the first identity',
      });
      await reattachLedgerSession(session, repoA);

      const oldPaths = pathsForRoot(repoA);
      const replacement = ensureAuthor(oldPaths, {
        email: 'replacement@example.com',
        name: 'Replacement Student',
      });
      writeState(oldPaths, {
        ...readState(oldPaths),
        currentAuthorSlug: replacement.slug,
      });

      await reattachLedgerSession(resolveLedgerSessionId(session.id)!, repoB);

      expect(promptTexts(repoA)).not.toContain('work recorded under the first identity');
      expect(promptTexts(repoB)).toContain('work recorded under the first identity');
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
    }
  });

  test('moving a projection removes only its vacated same-machine session record', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'vacated-session',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'move this projection',
      });
      await reattachLedgerSession(session, repoA);

      const oldPaths = pathsForRoot(repoA);
      const author = activeAuthorPaths(oldPaths)!;
      const projected = readSessions(author).find(
        (item) => item.nativeSessionId === 'vacated-session',
      )!;
      const otherMachine = {
        ...projected,
        id: 'ses_other_machine',
        machineId: 'other-machine',
      };
      writeFileSync(
        join(author.sessionsDir, 'other-machine.json'),
        JSON.stringify([otherMachine]) + '\n',
      );
      writeState(oldPaths, { ...readState(oldPaths), currentSessionId: projected.id });

      await reattachLedgerSession(resolveLedgerSessionId(session.id)!, repoB);

      const remaining = readSessions(author);
      expect(remaining.some((item) => item.id === projected.id)).toBe(false);
      expect(remaining.some((item) => item.id === otherMachine.id)).toBe(true);
      expect(readState(oldPaths).currentSessionId).toBeNull();
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
    }
  });

  test('moving a projection preserves a session with unrelated journal work', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'shared-local-session',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'move only the ledger batch',
      });
      await reattachLedgerSession(session, repoA);

      const oldPaths = pathsForRoot(repoA);
      const author = activeAuthorPaths(oldPaths)!;
      const projected = readSessions(author).find(
        (item) => item.nativeSessionId === 'shared-local-session',
      )!;
      await logEvent(author, {
        type: 'prompt',
        text: 'keep this unrelated source work',
        sessionId: projected.id,
      });
      writeState(oldPaths, { ...readState(oldPaths), currentSessionId: projected.id });

      await reattachLedgerSession(resolveLedgerSessionId(session.id)!, repoB);

      expect(promptTexts(repoA)).toEqual(['keep this unrelated source work']);
      expect(readSessions(author).some((item) => item.id === projected.id)).toBe(true);
      expect(readState(oldPaths).currentSessionId).toBe(projected.id);
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
    }
  });

  test('projection rejects an outside-root edit before writing any session records', async () => {
    const home = makeTempDir();
    const repo = makeTempDir();
    const elsewhere = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      const { paths } = await ensureInitialized(repo);
      const author = ensureAuthor(paths, {
        email: 'student@example.com',
        name: 'Student',
      });
      const outsideFile = join(elsewhere, 'outside.ts');
      writeFileSync(outsideFile, 'export const outside = true;\n');
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'outside-projection',
        cwd: repo,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'change a file elsewhere',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: outsideFile,
        diff: '+export const outside = true;',
      });

      await expect(materializeLedgerSession(session, author)).rejects.toBeInstanceOf(
        ProjectionOutsideRootError,
      );
      expect(readAllEvents(paths)).toEqual([]);
      expect(readAllArtifacts(paths)).toEqual([]);
    } finally {
      cleanup(home);
      cleanup(repo);
      cleanup(elsewhere);
    }
  });

  test('move rejects an already-projected multi-project range without disturbing it', async () => {
    const home = makeTempDir();
    const repoA = makeTempDir();
    const repoB = makeTempDir();
    const destination = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      mkdirSync(join(repoA, '.git'));
      mkdirSync(join(repoB, '.git'));
      const firstFile = join(repoA, 'one.ts');
      const secondFile = join(repoB, 'two.ts');
      writeFileSync(firstFile, 'export const one = 1;\n');
      writeFileSync(secondFile, 'export const two = 2;\n');
      const session = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 'ambiguous-after-placement',
        cwd: repoA,
      });
      appendLedgerRecord(session.id, {
        kind: 'prompt',
        tool: 'claude-code',
        text: 'change both projects',
      });
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: firstFile,
        diff: '+export const one = 1;',
      });
      await reattachLedgerSession(session, repoA);
      expect(promptTexts(repoA)).toContain('change both projects');

      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'claude-code',
        file: secondFile,
        diff: '+export const two = 2;',
      });
      const ranges = listActionableLedgerRanges({
        includeHidden: true,
        sessionId: session.id,
      });
      expect(ranges).toHaveLength(1);
      await expect(
        runMove(ranges[0]!.selector, { to: destination }),
      ).rejects.toHaveProperty('errorCode', 'EDIT_OUTSIDE_PROJECT');

      expect(promptTexts(repoA)).toContain('change both projects');
      expect(readLedgerSession(session.id)).toEqual(
        expect.objectContaining({
          status: 'placed',
          targets: [expect.objectContaining({ path: resolve(repoA) })],
        }),
      );
      expect(existsSync(join(destination, '.showtail'))).toBe(false);
    } finally {
      cleanup(home);
      cleanup(repoA);
      cleanup(repoB);
      cleanup(destination);
    }
  });

  // `runMove` backs both `showtail move` and its `reattach` alias — there is no
  // separate reattach entry point (it was dead code and was removed).
  test('move rejects an unknown work-range id with a helpful error', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await expect(runMove('led_does_not_exist', { to: dir })).rejects.toThrow(
        /No ledger work range/,
      );
    } finally {
      cleanup(home);
      cleanup(dir);
    }
  });
});
