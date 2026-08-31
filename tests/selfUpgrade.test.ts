import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareVersions,
  installedExecutablePath,
  releaseAssetName,
  selfUpgrade,
  windowsReplacementScript,
} from '../src/core/selfUpgrade.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function releaseFetch(
  version: string,
  binary: string,
  vsix = 'new vsix',
): { fetchFn: typeof fetch; calls: string[] } {
  const assetName = releaseAssetName('linux', 'x64');
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/releases/latest')) {
      return new Response(
        JSON.stringify({
          tag_name: `v${version}`,
          assets: [
            { name: assetName, browser_download_url: 'https://download.test/binary' },
            {
              name: 'showtail.vsix',
              browser_download_url: 'https://download.test/showtail.vsix',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/binary')) return new Response(binary, { status: 200 });
    if (url.endsWith('/showtail.vsix')) return new Response(vsix, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('self upgrade', () => {
  test('maps every release build target to its published asset', () => {
    expect(releaseAssetName('linux', 'x64')).toBe('showtail-linux-x64');
    expect(releaseAssetName('linux', 'arm64')).toBe('showtail-linux-arm64');
    expect(releaseAssetName('darwin', 'x64')).toBe('showtail-darwin-x64');
    expect(releaseAssetName('darwin', 'arm64')).toBe('showtail-darwin-arm64');
    expect(releaseAssetName('win32', 'x64')).toBe('showtail-windows-x64.exe');
    expect(() => releaseAssetName('win32', 'arm64')).toThrow(
      'Unsupported Windows architecture',
    );
  });

  test('compares Showtail release versions numerically', () => {
    expect(compareVersions('0.15.0', '0.15.0')).toBe(0);
    expect(compareVersions('0.16.0', '0.15.9')).toBe(1);
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1);
  });

  test('builds a Windows helper that waits, swaps both files, and refreshes hooks', () => {
    const script = windowsReplacementScript({
      target: "C:\\Users\\Student's PC\\showtail.exe",
      binaryTemp: 'C:\\temp\\new.exe',
      binaryBackup: 'C:\\temp\\old.exe',
      vsixTemp: 'C:\\temp\\new.vsix',
      vsixTarget: 'C:\\bin\\showtail.vsix',
      vsixBackup: 'C:\\temp\\old.vsix',
      parentPid: 42,
    });
    expect(script).toContain("Student''s PC");
    expect(script).toContain('Get-Process -Id $parentPid');
    expect(script).toContain('$binaryStaged = $true');
    expect(script).toContain('Move-Item -LiteralPath $download');
    expect(script).toContain('Move-Item -LiteralPath $vsixDownload');
    expect(script).toContain('& $target setup --first-run --json');
  });

  test('refuses to replace a runtime or source-managed executable', () => {
    const dir = makeTempDir();
    try {
      const runtime = join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun');
      writeFileSync(runtime, 'runtime');
      expect(() => installedExecutablePath(runtime)).toThrow(
        'updates standalone installs only',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('downloads, verifies, and replaces the binary and bundled extension', async () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'showtail');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(target, 'old binary');
      writeFileSync(vsix, 'old vsix');
      const remote = releaseFetch('0.16.0', 'new binary');

      const result = await selfUpgrade({
        targetPath: target,
        currentVersion: '0.15.0',
        platform: 'linux',
        arch: 'x64',
        fetchFn: remote.fetchFn,
        verifyDownloaded(path, expectedVersion) {
          expect(readFileSync(path, 'utf8')).toBe('new binary');
          expect(expectedVersion).toBe('0.16.0');
        },
        refreshInstalledIntegrations(path) {
          expect(path).toBe(target);
          expect(readFileSync(path, 'utf8')).toBe('new binary');
          return true;
        },
      });

      expect(result.status).toBe('upgraded');
      expect(result.extensionUpdated).toBe(true);
      expect(result.integrationsRefreshed).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new binary');
      expect(readFileSync(vsix, 'utf8')).toBe('new vsix');
      expect(
        readdirSync(dir).filter((name) => name.startsWith('.showtail-upgrade')),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('does not download assets when the installed version is current', async () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'showtail');
      writeFileSync(target, 'same binary');
      const remote = releaseFetch('0.15.0', 'unused');
      const result = await selfUpgrade({
        targetPath: target,
        currentVersion: '0.15.0',
        platform: 'linux',
        arch: 'x64',
        fetchFn: remote.fetchFn,
      });

      expect(result.status).toBe('current');
      expect(remote.calls).toHaveLength(1);
      expect(readFileSync(target, 'utf8')).toBe('same binary');
    } finally {
      cleanup(dir);
    }
  });

  test('keeps the installed files intact when verification fails', async () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'showtail');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(target, 'old binary');
      writeFileSync(vsix, 'old vsix');
      const remote = releaseFetch('0.16.0', 'bad binary');

      await expect(
        selfUpgrade({
          targetPath: target,
          currentVersion: '0.15.0',
          platform: 'linux',
          arch: 'x64',
          fetchFn: remote.fetchFn,
          verifyDownloaded() {
            throw new Error('verification failed');
          },
        }),
      ).rejects.toThrow('verification failed');

      expect(readFileSync(target, 'utf8')).toBe('old binary');
      expect(readFileSync(vsix, 'utf8')).toBe('old vsix');
      expect(
        readdirSync(dir).filter((name) => name.startsWith('.showtail-upgrade')),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('rolls both installed files back when the replacement is interrupted', async () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'showtail');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(target, 'old binary');
      writeFileSync(vsix, 'old vsix');
      const remote = releaseFetch('0.16.0', 'new binary');
      let replacements = 0;

      await expect(
        selfUpgrade({
          targetPath: target,
          currentVersion: '0.15.0',
          platform: 'linux',
          arch: 'x64',
          fetchFn: remote.fetchFn,
          verifyDownloaded() {},
          replaceDownloaded(source, destination) {
            replacements += 1;
            if (replacements === 2) throw new Error('replacement interrupted');
            renameSync(source, destination);
          },
        }),
      ).rejects.toThrow('replacement interrupted');

      expect(readFileSync(target, 'utf8')).toBe('old binary');
      expect(readFileSync(vsix, 'utf8')).toBe('old vsix');
      expect(
        readdirSync(dir).filter((name) => name.startsWith('.showtail-upgrade')),
      ).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
