/**
 * Unit tests for the inbox surface predicate — which never-placed ledger sessions
 * `showtail inbox` shows by default vs keeps aside (recoverable via `--all`). Covers
 * eligibility (real project vs folderless/temp), the signal floor, the scratch list,
 * dismissal, and the membership-vs-resolved-root distinction.
 *
 * Ledger writes go to the shared `SHOWTAIL_HOME` and are cleared between tests by the
 * preload (tests/setup.ts). `SHOWTAIL_ROOT_CEILING` is pinned to the OS temp dir there,
 * so a `.git` fixture under a temp dir resolves as a real project (the temp-dir
 * exclusion is a production-only guard; it's unit-tested directly via `isTempPath`).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, makeTempDir } from './helpers.ts';
import {
  addScratchPath,
  removeScratchPath,
  DEFAULT_INBOX_MIN_SIGNAL,
} from '../src/core/globalConfig.ts';
import {
  appendLedgerRecord,
  dismissLedgerSession,
  ensureLedgerSession,
  hiddenReason,
  isSurfaced,
  sessionTouchesPath,
  sessionWorkRoots,
  type LedgerSession,
} from '../src/core/ledger.ts';
import { isTempPath } from '../src/core/storage.ts';

/** A ledger session with N prompts and edits at the given absolute file paths. */
function makeSession(
  nativeId: string,
  opts: { prompts?: number; editFiles?: string[]; cwd?: string } = {},
): LedgerSession {
  const s = ensureLedgerSession({
    tool: 'claude-code',
    nativeSessionId: nativeId,
    cwd: opts.cwd,
  });
  for (let i = 0; i < (opts.prompts ?? 0); i += 1) {
    appendLedgerRecord(s.id, { kind: 'prompt', tool: 'claude-code', text: `p${i}` });
  }
  for (const file of opts.editFiles ?? []) {
    appendLedgerRecord(s.id, { kind: 'edit', tool: 'claude-code', file });
  }
  return s;
}

/** A temp dir marked as a git repo (an eligible, non-tracked project). */
function makeRepo(): string {
  const dir = makeTempDir();
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

describe('inbox surface predicate', () => {
  test('folderless work (no eligible root) is hidden as not-in-project', () => {
    const scratch = makeTempDir(); // no .git / .showtail
    try {
      const s = makeSession('s-folderless', {
        prompts: 3,
        editFiles: [join(scratch, 'a.ts')],
      });
      expect(isSurfaced(s)).toBe(false);
      expect(hiddenReason(s)).toBe('not-in-project');
    } finally {
      cleanup(scratch);
    }
  });

  test('work inside a real repo surfaces', () => {
    const repo = makeRepo();
    try {
      const s = makeSession('s-real', { prompts: 1, editFiles: [join(repo, 'a.ts')] });
      expect(hiddenReason(s)).toBeNull();
      expect(isSurfaced(s)).toBe(true);
      expect(sessionWorkRoots(s)).toContain(repo);
    } finally {
      cleanup(repo);
    }
  });

  test('an eligible but low-signal session is hidden', () => {
    const repo = makeRepo();
    try {
      // cwd is the repo (eligible), but 1 prompt / 0 edits is below the floor.
      const s = makeSession('s-lowsignal', { prompts: 1, cwd: repo });
      expect(DEFAULT_INBOX_MIN_SIGNAL).toEqual({ edits: 1, prompts: 2 });
      expect(hiddenReason(s)).toBe('low-signal');
    } finally {
      cleanup(repo);
    }
  });

  test('a user-ignored (scratch) folder hides otherwise-surfaced work', () => {
    const repo = makeRepo();
    try {
      const s = makeSession('s-scratch', { prompts: 2, editFiles: [join(repo, 'a.ts')] });
      expect(isSurfaced(s)).toBe(true);

      addScratchPath(repo);
      expect(hiddenReason(s)).toBe('ignored-path');

      removeScratchPath(repo);
      expect(isSurfaced(s)).toBe(true);
    } finally {
      cleanup(repo);
    }
  });

  test('dismissal hides a session (highest-priority reason) and is reversible', () => {
    const repo = makeRepo();
    try {
      const s = makeSession('s-dismiss', { prompts: 2, editFiles: [join(repo, 'a.ts')] });
      expect(isSurfaced(s)).toBe(true);
      dismissLedgerSession(s.id);
      // Re-read to see the persisted dismissedAt.
      const again = ensureLedgerSession({
        tool: 'claude-code',
        nativeSessionId: 's-dismiss',
      });
      expect(hiddenReason(again)).toBe('dismissed');
    } finally {
      cleanup(repo);
    }
  });

  test('membership is a raw prefix, not the resolved root (subfolder still matches)', () => {
    const repo = makeRepo();
    const sub = join(repo, 'sub');
    try {
      mkdirSync(sub, { recursive: true });
      const s = makeSession('s-sub', { prompts: 1, editFiles: [join(sub, 'a.ts')] });
      // Resolved root is the git repo…
      expect(sessionWorkRoots(s)).toContain(repo);
      // …but membership matches the subfolder the edit actually lives in — which the
      // resolved-root would miss. This is what makes `track <subfolder>` / `ignore
      // <subfolder>` work.
      expect(sessionTouchesPath(s, sub)).toBe(true);
      expect(sessionTouchesPath(s, repo)).toBe(true);
      expect(sessionTouchesPath(s, makeTempDir())).toBe(false);
    } finally {
      cleanup(repo);
    }
  });
});

describe('isTempPath', () => {
  test('flags the OS temp dir and /tmp, not ordinary project paths', () => {
    expect(isTempPath(join(tmpdir(), 'NameColorPlugin'))).toBe(true);
    expect(isTempPath('/tmp/foo')).toBe(true);
    expect(isTempPath(join(homedir(), 'code', 'my-project'))).toBe(false);
  });
});
