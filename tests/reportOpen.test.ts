import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { reportTargets, resolveOpenAction } from '../src/commands/report.ts';
import { readAutoOpenReport, setAutoOpenReport } from '../src/core/globalConfig.ts';
import { keyToChoice, promptOpenReport } from '../src/core/prompt.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

const INTERACTIVE = true;
const NON_INTERACTIVE = false;

describe('resolveOpenAction', () => {
  test('--open opens, --no-open skips (regardless of preference)', () => {
    expect(resolveOpenAction({ open: true }, 'never', INTERACTIVE)).toBe('open');
    expect(resolveOpenAction({ open: false }, 'always', INTERACTIVE)).toBe('skip');
  });

  test('--json never auto-opens', () => {
    expect(resolveOpenAction({ json: true }, 'always', INTERACTIVE)).toBe('skip');
  });

  test('non-interactive runs never auto-open or prompt', () => {
    expect(resolveOpenAction({}, 'always', NON_INTERACTIVE)).toBe('skip');
    expect(resolveOpenAction({}, 'ask', NON_INTERACTIVE)).toBe('skip');
    expect(resolveOpenAction({}, 'never', NON_INTERACTIVE)).toBe('skip');
  });

  test('remembered preference drives interactive runs', () => {
    expect(resolveOpenAction({}, 'always', INTERACTIVE)).toBe('open');
    expect(resolveOpenAction({}, 'never', INTERACTIVE)).toBe('skip');
    expect(resolveOpenAction({}, 'ask', INTERACTIVE)).toBe('ask');
  });

  test('--ask forces the menu even when a choice is remembered', () => {
    expect(resolveOpenAction({ ask: true }, 'always', INTERACTIVE)).toBe('ask');
    expect(resolveOpenAction({ ask: true }, 'never', INTERACTIVE)).toBe('ask');
  });
});

describe('autoOpenReport preference', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = makeTempDir();
    prevHome = process.env.SHOWTAIL_HOME;
    process.env.SHOWTAIL_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = prevHome;
    cleanup(home);
  });

  test('defaults to ask and round-trips always/never', () => {
    expect(readAutoOpenReport()).toBe('ask');
    setAutoOpenReport('always');
    expect(readAutoOpenReport()).toBe('always');
    setAutoOpenReport('never');
    expect(readAutoOpenReport()).toBe('never');
  });
});

describe('promptOpenReport', () => {
  test('resolves skip immediately when not an interactive TTY', async () => {
    // Under the test runner, stdin/stdout are not TTYs, so the menu must not block.
    const primary = { label: 'team', path: '/x/report.html' };
    const choice = await promptOpenReport([primary], primary);
    expect(choice).toEqual({ kind: 'skip' });
  });
});

describe('keyToChoice', () => {
  const team = { label: 'team', path: '/r/team.html' };
  const alice = { label: 'alice', path: '/r/alice.html' };
  const bob = { label: 'bob', path: '/r/bob.html' };

  test('solo: o opens the sole report, a/n remember, others skip', () => {
    const solo = [alice];
    expect(keyToChoice('o', solo, alice)).toEqual({ kind: 'open', path: alice.path });
    expect(keyToChoice('O', solo, alice)).toEqual({ kind: 'open', path: alice.path });
    expect(keyToChoice('a', solo, alice)).toEqual({ kind: 'always' });
    expect(keyToChoice('n', solo, alice)).toEqual({ kind: 'never' });
    expect(keyToChoice('1', solo, alice)).toEqual({ kind: 'skip' }); // no numbers when solo
    expect(keyToChoice('x', solo, alice)).toEqual({ kind: 'skip' });
  });

  test('multi: digits open the matching report, a/n remember', () => {
    const multi = [team, alice, bob];
    expect(keyToChoice('1', multi, team)).toEqual({ kind: 'open', path: team.path });
    expect(keyToChoice('2', multi, team)).toEqual({ kind: 'open', path: alice.path });
    expect(keyToChoice('3', multi, team)).toEqual({ kind: 'open', path: bob.path });
    expect(keyToChoice('4', multi, team)).toEqual({ kind: 'skip' }); // out of range
    expect(keyToChoice('a', multi, team)).toEqual({ kind: 'always' });
    expect(keyToChoice('n', multi, team)).toEqual({ kind: 'never' });
    expect(keyToChoice('o', multi, team)).toEqual({ kind: 'skip' }); // no 'o' when multi
  });

  test('Esc, Ctrl-C, Enter, and arrow sequences all skip', () => {
    const multi = [team, alice];
    expect(keyToChoice('\x1b', multi, team)).toEqual({ kind: 'skip' }); // Esc
    expect(keyToChoice('\x03', multi, team)).toEqual({ kind: 'skip' }); // Ctrl-C
    expect(keyToChoice('\r', multi, team)).toEqual({ kind: 'skip' }); // Enter
    expect(keyToChoice('\x1b[A', multi, team)).toEqual({ kind: 'skip' }); // up arrow
  });
});

describe('reportTargets', () => {
  test('team report only when there are multiple contributors', () => {
    const dir = makeTempDir();
    try {
      const paths = pathsForRoot(dir);
      const keys = (opts: Parameters<typeof reportTargets>[1], slugs: string[]) =>
        reportTargets(paths, opts, slugs).map((t) => t.key);

      expect(keys({}, [])).toEqual(['team']); // no profiles → one default report
      expect(keys({}, ['alice'])).toEqual(['alice']); // solo → no team report
      expect(keys({}, ['alice', 'bob'])).toEqual(['team', 'alice', 'bob']);
      // Explicit flags are unaffected by the contributor count.
      expect(keys({ team: true }, ['alice', 'bob'])).toEqual(['team']);
      expect(keys({ author: 'bob' }, ['alice', 'bob'])).toEqual(['bob']);
    } finally {
      cleanup(dir);
    }
  });
});
