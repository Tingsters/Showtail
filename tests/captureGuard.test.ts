import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runInit } from '../src/commands/init.ts';
import { CaptureInterruptedError } from '../src/core/captureGuard.ts';
import { logEvent, readAllEvents } from '../src/core/events.ts';
import { addressOf, objectExists } from '../src/core/objects.ts';
import {
  pathsForRoot,
  readConfig,
  readSessions,
  readState,
  writeConfig,
} from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.SHOWTAIL_HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
  else process.env.SHOWTAIL_HOME = previousHome;
});

describe('automatic capture write guards', () => {
  test('revocation during auto-start rolls back the new session and shared state', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const initialState = readState(paths);
      let checks = 0;

      await expect(
        logEvent(author, {
          type: 'prompt',
          text: 'do not leave an interrupted session behind',
          tool: 'codex',
          timestamp: new Date().toISOString(),
          continueCapture: () => {
            checks += 1;
            return checks < 4;
          },
        }),
      ).rejects.toBeInstanceOf(CaptureInterruptedError);

      expect(checks).toBe(4);
      expect(readSessions(author)).toEqual([]);
      expect(readState(paths)).toEqual(initialState);
      expect(readAllEvents(paths)).toEqual([]);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });

  test('revocation during live event metadata lookup writes no content or journal entry', async () => {
    const home = makeTempDir();
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_HOME = home;
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const config = readConfig(paths);
      config.settings.git = true;
      writeConfig(paths, config);
      const text = 'do not persist after the capture window changes';
      let enabled = true;

      const pending = logEvent(author, {
        type: 'prompt',
        text,
        tool: 'codex',
        continueCapture: () => enabled,
      });
      queueMicrotask(() => {
        enabled = false;
      });

      await expect(pending).rejects.toBeInstanceOf(CaptureInterruptedError);
      expect(readAllEvents(paths)).toHaveLength(0);
      expect(objectExists(paths, addressOf(text))).toBe(false);
    } finally {
      cleanup(dir);
      cleanup(home);
    }
  });
});
