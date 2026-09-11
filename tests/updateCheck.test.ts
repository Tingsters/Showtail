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
import { SHOWTAIL_VERSION } from '../src/core/version.ts';
import { cleanup, makeTempDir } from './helpers.ts';

const [major = 0, minor = 0, patch = 0] = SHOWTAIL_VERSION.split('.').map(Number);
const NEWER_VERSION = `${major}.${minor}.${patch + 1}`;

function releaseFetch(version = NEWER_VERSION): FetchFn {
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
      command: 'report',
      stdinIsTTY: true,
      stderrIsTTY: true,
      disabledByEnv: false,
      ci: false,
      now,
      fetchFn: releaseFetch(),
    };
    expect(await passiveUpdateNotice(options)).toContain(
      `${SHOWTAIL_VERSION} -> ${NEWER_VERSION}`,
    );
    expect(await passiveUpdateNotice(options)).toBeNull();
    expect(cachedUpdateStatus()).toMatchObject({
      latestVersion: NEWER_VERSION,
      updateAvailable: true,
    });
  });

  test('repeats a cached reminder only after seven days', async () => {
    isolateHome();
    writeGlobalConfig({
      version: 1,
      update: {
        lastCheckedAt: '2026-09-08T12:00:00.000Z',
        latestVersion: NEWER_VERSION,
        lastNotifiedVersion: NEWER_VERSION,
        lastNotifiedAt: '2026-09-08T12:00:00.000Z',
      },
    });
    const notice = await passiveUpdateNotice({
      command: 'report',
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
    for (const command of ['projects', 'verify']) {
      expect(
        passiveUpdateCheckAllowed({
          command,
          stdinIsTTY: true,
          stderrIsTTY: true,
          disabledByEnv: false,
          ci: false,
        }),
      ).toBe(false);
    }
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
