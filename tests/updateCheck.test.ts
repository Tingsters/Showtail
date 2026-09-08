import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cachedUpdateStatus,
  passiveUpdateCheckAllowed,
  passiveUpdateNotice,
  setAutomaticUpdateChecks,
} from '../src/core/updateCheck.ts';
import { readGlobalConfig, writeGlobalConfig } from '../src/core/globalConfig.ts';
import type { FetchFn } from '../src/core/releases.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function releaseFetch(version = '0.16.0'): FetchFn {
  return (async () =>
    new Response(
      JSON.stringify({
        tag_name: `v${version}`,
        html_url: `https://github.com/Tingsters/Showtail/releases/tag/v${version}`,
        draft: false,
        prerelease: false,
        assets: [],
      }),
    )) as FetchFn;
}

describe('automatic update checks', () => {
  const originalHome = process.env.SHOWTAIL_HOME;
  let home: string | undefined;

  function isolateHome(): void {
    home = makeTempDir();
    process.env.SHOWTAIL_HOME = home;
  }

  afterEach(() => {
    if (home) cleanup(home);
    home = undefined;
    if (originalHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = originalHome;
  });

  test('discovers a release once and throttles repeated reminders', async () => {
    isolateHome();
    const now = new Date('2026-09-08T12:00:00.000Z');
    const options = {
      command: 'status',
      stdinIsTTY: true,
      stderrIsTTY: true,
      disabledByEnv: false,
      ci: false,
      now,
      fetchFn: releaseFetch(),
    };
    expect(await passiveUpdateNotice(options)).toContain('0.15.0 -> 0.16.0');
    expect(await passiveUpdateNotice(options)).toBeNull();
    expect(cachedUpdateStatus()).toMatchObject({
      latestVersion: '0.16.0',
      updateAvailable: true,
    });
  });

  test('repeats a cached reminder only after seven days', async () => {
    isolateHome();
    writeGlobalConfig({
      version: 1,
      update: {
        lastCheckedAt: '2026-09-08T12:00:00.000Z',
        latestVersion: '0.16.0',
        lastNotifiedVersion: '0.16.0',
        lastNotifiedAt: '2026-09-08T12:00:00.000Z',
      },
    });
    const notice = await passiveUpdateNotice({
      command: 'status',
      stdinIsTTY: true,
      stderrIsTTY: true,
      disabledByEnv: false,
      ci: false,
      now: new Date('2026-09-16T12:00:00.000Z'),
      fetchFn: releaseFetch(),
    });
    expect(notice).toContain('showtail update');
  });

  test('respects persistent opt-out and noninteractive commands', async () => {
    isolateHome();
    setAutomaticUpdateChecks(false);
    expect(readGlobalConfig().update?.automaticChecks).toBe(false);
    expect(
      passiveUpdateCheckAllowed({
        command: 'status',
        stdinIsTTY: true,
        stderrIsTTY: true,
        disabledByEnv: false,
        ci: false,
      }),
    ).toBe(false);
    setAutomaticUpdateChecks(true);
    expect(
      passiveUpdateCheckAllowed({
        command: 'status',
        stdinIsTTY: false,
        stderrIsTTY: true,
        disabledByEnv: false,
        ci: false,
      }),
    ).toBe(false);
    expect(
      passiveUpdateCheckAllowed({
        command: 'hook',
        stdinIsTTY: true,
        stderrIsTTY: true,
        disabledByEnv: false,
        ci: false,
      }),
    ).toBe(false);
  });

  test('network failures stay silent and record a retry watermark', async () => {
    isolateHome();
    const notice = await passiveUpdateNotice({
      command: 'report',
      stdinIsTTY: true,
      stderrIsTTY: true,
      disabledByEnv: false,
      ci: false,
      now: new Date('2026-09-08T12:00:00.000Z'),
      fetchFn: (async () => {
        throw new Error('offline');
      }) as FetchFn,
    });
    expect(notice).toBeNull();
    expect(readGlobalConfig().update?.lastAttemptedAt).toBe('2026-09-08T12:00:00.000Z');
  });

  test('an unwritable cache keeps passive checks silent', async () => {
    home = makeTempDir();
    const blockedHome = join(home, 'not-a-directory');
    writeFileSync(blockedHome, 'blocked');
    process.env.SHOWTAIL_HOME = blockedHome;

    await expect(
      passiveUpdateNotice({
        command: 'status',
        stdinIsTTY: true,
        stderrIsTTY: true,
        disabledByEnv: false,
        ci: false,
        now: new Date('2026-09-08T12:00:00.000Z'),
        fetchFn: releaseFetch(),
      }),
    ).resolves.toBeNull();
  });
});
