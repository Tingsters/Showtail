import { afterEach, describe, expect, test } from 'bun:test';
import { runUpdate } from '../src/commands/update.ts';
import type { ShowtailRelease } from '../src/core/releases.ts';
import { readGlobalConfig } from '../src/core/globalConfig.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function release(version: string): ShowtailRelease {
  return {
    version,
    tag: `v${version}`,
    pageUrl: `https://github.com/Tingsters/Showtail/releases/tag/v${version}`,
    assets: [],
  };
}

describe('update command', () => {
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

  test('reports an already-current installation without installing', async () => {
    isolateHome();
    let installs = 0;
    const result = await runUpdate({
      json: true,
      currentVersion: '0.16.0',
      fetchRelease: async () => release('0.16.0'),
      installRelease: async () => {
        installs += 1;
        return { status: 'updated' };
      },
    });
    expect(result.status).toBe('current');
    expect(installs).toBe(0);
  });

  test('--check reports availability without installing', async () => {
    isolateHome();
    let installs = 0;
    const result = await runUpdate({
      check: true,
      json: true,
      currentVersion: '0.15.0',
      fetchRelease: async () => release('0.16.0'),
      installRelease: async () => {
        installs += 1;
        return { status: 'updated' };
      },
    });
    expect(result.status).toBe('available');
    expect(result.updateAvailable).toBe(true);
    expect(installs).toBe(0);
  });

  test('installs a newer release and records it in the cache', async () => {
    isolateHome();
    const result = await runUpdate({
      json: true,
      currentVersion: '0.15.0',
      fetchRelease: async () => release('0.16.0'),
      installRelease: async () => ({ status: 'updated', target: '/tmp/showtail' }),
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'updated',
      currentVersion: '0.15.0',
      latestVersion: '0.16.0',
    });
    expect(readGlobalConfig().update).toMatchObject({
      latestVersion: '0.16.0',
      lastCheckedAt: '2026-09-08T12:00:00.000Z',
    });
  });

  test('persists the automatic-check preference without contacting GitHub', async () => {
    isolateHome();
    let fetched = false;
    const result = await runUpdate({
      json: true,
      autoCheck: 'off',
      fetchRelease: async () => {
        fetched = true;
        return release('0.16.0');
      },
    });
    expect(result).toEqual({ status: 'configured', automaticChecks: false });
    expect(readGlobalConfig().update?.automaticChecks).toBe(false);
    expect(fetched).toBe(false);
  });

  test('does not overwrite Bun when the CLI is running from source', async () => {
    isolateHome();
    const result = await runUpdate({
      json: true,
      currentVersion: '0.15.0',
      executablePath: process.execPath,
      fetchRelease: async () => release('0.16.0'),
    });
    expect(result).toMatchObject({
      status: 'manual',
      latestVersion: '0.16.0',
      updateAvailable: true,
    });
  });

  test('rejects an invalid automatic-check setting before checking releases', async () => {
    isolateHome();
    await expect(runUpdate({ autoCheck: 'sometimes' })).rejects.toThrow(
      '--auto-check must be either "on" or "off"',
    );
  });
});
