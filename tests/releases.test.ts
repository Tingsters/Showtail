import { describe, expect, test } from 'bun:test';
import {
  binaryAssetName,
  compareVersions,
  fetchLatestRelease,
  isNewerVersion,
  releaseDownloadUrlIsTrusted,
  requireReleaseAsset,
  type FetchFn,
} from '../src/core/releases.ts';

const trustedBase = 'https://github.com/Tingsters/Showtail/releases/download/v0.16.0';

describe('release discovery', () => {
  test('compares plain semantic versions numerically', () => {
    expect(compareVersions('0.16.0', '0.15.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.3', '2.0.0')).toBe(-1);
    expect(isNewerVersion('0.16.0', '0.15.0')).toBe(true);
    expect(() => compareVersions('v0.16.0', '0.15.0')).toThrow(
      'Invalid Showtail version',
    );
  });

  test('maps every supported release target', () => {
    expect(binaryAssetName('win32', 'x64')).toBe('showtail-windows-x64.exe');
    expect(binaryAssetName('darwin', 'arm64')).toBe('showtail-darwin-arm64');
    expect(binaryAssetName('darwin', 'x64')).toBe('showtail-darwin-x64');
    expect(binaryAssetName('linux', 'arm64')).toBe('showtail-linux-arm64');
    expect(binaryAssetName('linux', 'x64')).toBe('showtail-linux-x64');
    expect(() => binaryAssetName('win32', 'arm64')).toThrow('Unsupported Windows');
    expect(() => binaryAssetName('freebsd', 'x64')).toThrow('Unsupported platform');
  });

  test('parses a stable GitHub release and its digest', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.16.0',
          html_url: 'https://github.com/Tingsters/Showtail/releases/tag/v0.16.0',
          draft: false,
          prerelease: false,
          assets: [
            {
              name: 'showtail-windows-x64.exe',
              browser_download_url: `${trustedBase}/showtail-windows-x64.exe`,
              size: 123,
              digest: `sha256:${'a'.repeat(64)}`,
            },
          ],
        }),
        { status: 200 },
      )) as FetchFn;

    const release = await fetchLatestRelease({ fetchFn, timeoutMs: 100 });
    expect(release.version).toBe('0.16.0');
    expect(requireReleaseAsset(release, 'showtail-windows-x64.exe').sha256).toBe(
      'a'.repeat(64),
    );
  });

  test('drops untrusted asset URLs', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.16.0',
          html_url: '',
          assets: [
            {
              name: 'showtail-windows-x64.exe',
              browser_download_url: 'https://example.com/showtail.exe',
              size: 123,
            },
          ],
        }),
      )) as FetchFn;
    const release = await fetchLatestRelease({ fetchFn });
    expect(release.assets).toHaveLength(0);
    expect(() => requireReleaseAsset(release, 'showtail-windows-x64.exe')).toThrow(
      'does not include',
    );
    expect(releaseDownloadUrlIsTrusted('https://example.com/showtail.exe')).toBe(false);
  });
});
