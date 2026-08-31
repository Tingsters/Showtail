import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import {
  autoInitEnabled,
  detectHistoryUpgrade,
  globalConfigPath,
  readGlobalConfig,
  showtailHome,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('global config (~/.showtail-cli)', () => {
  const original = process.env.SHOWTAIL_HOME;
  let dir: string | undefined;

  /** Point SHOWTAIL_HOME at a throwaway temp dir for the duration of a test. */
  function withTempHome(): string {
    dir = makeTempDir();
    process.env.SHOWTAIL_HOME = dir;
    return dir;
  }

  afterEach(() => {
    if (dir) cleanup(dir);
    dir = undefined;
    if (original === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = original;
  });

  test('defaults to version 1 with auto-init off when no file exists', () => {
    withTempHome();
    expect(readGlobalConfig()).toEqual({ version: 1 });
    expect(autoInitEnabled()).toBe(false);
  });

  test('round-trips a written config', () => {
    withTempHome();
    writeGlobalConfig({
      version: 1,
      autoInit: true,
      setupCompletedAt: '2026-06-20T00:00:00.000Z',
    });
    expect(autoInitEnabled()).toBe(true);
    expect(readGlobalConfig().setupCompletedAt).toBe('2026-06-20T00:00:00.000Z');
  });

  test('a corrupt file returns the default instead of throwing', () => {
    withTempHome();
    writeFileSync(globalConfigPath(), 'not json {', 'utf8');
    expect(() => readGlobalConfig()).not.toThrow();
    expect(readGlobalConfig()).toEqual({ version: 1 });
    expect(autoInitEnabled()).toBe(false);
  });

  test('SHOWTAIL_HOME overrides the location', () => {
    const home = withTempHome();
    expect(showtailHome()).toBe(home);
  });

  test('an existing generation-1 install gets one pending generation-2 offer', () => {
    withTempHome();
    writeGlobalConfig({ version: 1, autoInit: true });
    const offer = detectHistoryUpgrade(2, '2026-08-30T12:00:00.000Z');
    expect(offer).toEqual({
      generation: 2,
      status: 'pending',
      detectedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(detectHistoryUpgrade(2)).toEqual(offer);
  });

  test('a machine with no prior global config is a fresh install, not an upgrade', () => {
    withTempHome();
    expect(detectHistoryUpgrade(2)).toBeUndefined();
    expect(readGlobalConfig()).toEqual({ version: 1 });
  });
});
