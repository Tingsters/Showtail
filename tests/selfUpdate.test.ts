import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  installShowtailRelease,
  isStandaloneExecutable,
  windowsReplacementScript,
  type WindowsReplacementOptions,
} from '../src/core/selfUpdate.ts';
import { sha256OfBytes } from '../src/core/hash.ts';
import type { FetchFn, ShowtailRelease } from '../src/core/releases.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function fixtureRelease(
  assetName: string,
  bytes: Uint8Array,
  sha256 = sha256OfBytes(bytes),
): ShowtailRelease {
  return {
    version: '0.16.0',
    tag: 'v0.16.0',
    pageUrl: 'https://github.com/Tingsters/Showtail/releases/tag/v0.16.0',
    assets: [
      {
        name: assetName,
        url: `https://github.com/Tingsters/Showtail/releases/download/v0.16.0/${assetName}`,
        size: bytes.byteLength,
        sha256,
      },
    ],
  };
}

function bytesFetch(bytes: Uint8Array): FetchFn {
  return (async () => new Response(bytes)) as FetchFn;
}

describe('standalone self-update', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) cleanup(dir);
    dir = undefined;
  });

  test('distinguishes standalone binaries from source runtimes', () => {
    expect(isStandaloneExecutable('/usr/local/bin/showtail')).toBe(true);
    expect(isStandaloneExecutable('C:\\Tools\\showtail.exe')).toBe(true);
    expect(isStandaloneExecutable('/usr/local/bin/bun')).toBe(false);
    expect(isStandaloneExecutable('C:\\Tools\\bun.exe')).toBe(false);
  });

  test('replaces a verified executable and preserves the target path', async () => {
    dir = makeTempDir();
    const target = join(dir, 'showtail');
    const next = new TextEncoder().encode('new executable');
    writeFileSync(target, 'old executable');
    const result = await installShowtailRelease(
      fixtureRelease('showtail-linux-x64', next),
      {
        platform: 'linux',
        arch: 'x64',
        executablePath: target,
        fetchFn: bytesFetch(next),
        verifyExecutable: () => true,
      },
    );
    expect(result.status).toBe('updated');
    expect(readFileSync(target, 'utf8')).toBe('new executable');
  });

  test('rejects a bad digest before replacing the old executable', async () => {
    dir = makeTempDir();
    const target = join(dir, 'showtail');
    const next = new TextEncoder().encode('tampered executable');
    writeFileSync(target, 'old executable');
    await expect(
      installShowtailRelease(fixtureRelease('showtail-linux-x64', next, '0'.repeat(64)), {
        platform: 'linux',
        arch: 'x64',
        executablePath: target,
        fetchFn: bytesFetch(next),
        verifyExecutable: () => true,
      }),
    ).rejects.toThrow('SHA-256 verification failed');
    expect(readFileSync(target, 'utf8')).toBe('old executable');
  });

  test('uses the published checksum manifest when GitHub omits an asset digest', async () => {
    dir = makeTempDir();
    const target = join(dir, 'showtail');
    const next = new TextEncoder().encode('manifest verified executable');
    const hash = sha256OfBytes(next);
    writeFileSync(target, 'old executable');
    const release = fixtureRelease('showtail-linux-x64', next);
    delete release.assets[0]!.sha256;
    release.assets.push({
      name: 'SHA256SUMS',
      url: 'https://github.com/Tingsters/Showtail/releases/download/v0.16.0/SHA256SUMS',
      size: 0,
    });
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/SHA256SUMS')) {
        return new Response(`${hash}  showtail-linux-x64\n`);
      }
      return new Response(next);
    }) as FetchFn;
    const result = await installShowtailRelease(release, {
      platform: 'linux',
      arch: 'x64',
      executablePath: target,
      fetchFn,
      verifyExecutable: () => true,
    });
    expect(result.status).toBe('updated');
    expect(readFileSync(target, 'utf8')).toBe('manifest verified executable');
  });

  test('rolls back when the replacement reports the wrong version', async () => {
    dir = makeTempDir();
    const target = join(dir, 'showtail');
    const next = new TextEncoder().encode('bad executable');
    writeFileSync(target, 'old executable');
    await expect(
      installShowtailRelease(fixtureRelease('showtail-linux-x64', next), {
        platform: 'linux',
        arch: 'x64',
        executablePath: target,
        fetchFn: bytesFetch(next),
        verifyExecutable: () => false,
      }),
    ).rejects.toThrow('expected version');
    expect(readFileSync(target, 'utf8')).toBe('old executable');
  });

  test('hands a running Windows executable to the background helper', async () => {
    dir = makeTempDir();
    const target = join(dir, 'showtail.exe');
    const next = new TextEncoder().encode('new executable');
    writeFileSync(target, 'old executable');
    let helper: WindowsReplacementOptions | undefined;
    const result = await installShowtailRelease(
      fixtureRelease('showtail-windows-x64.exe', next),
      {
        platform: 'win32',
        arch: 'x64',
        executablePath: target,
        runningExecutablePath: target,
        fetchFn: bytesFetch(next),
        launchWindowsHelper: async (options) => {
          helper = options;
        },
      },
    );
    expect(result.status).toBe('pending');
    expect(helper).toMatchObject({ target, expectedVersion: '0.16.0' });
    expect(helper?.vsixBackup).toContain('.showtail-vsix-');
    expect(helper?.binaryTemp && readFileSync(helper.binaryTemp, 'utf8')).toBe(
      'new executable',
    );
    expect(readFileSync(target, 'utf8')).toBe('old executable');
  });

  test('the Windows helper waits, verifies, and restores on failure', () => {
    const script = windowsReplacementScript();
    expect(script).toContain('Get-Process -Id $ParentPid');
    expect(script).toContain('& $Target --version');
    expect(script).toContain('Move-Item -LiteralPath $Backup -Destination $Target');
    expect(script).toContain('Write-UpdateResult $false');
  });

  test('the Windows helper replaces and verifies a real command file', () => {
    if (process.platform !== 'win32') return;
    dir = makeTempDir();
    const target = join(dir, 'showtail.cmd');
    const binaryTemp = join(dir, 'showtail.tmp');
    const backup = join(dir, 'showtail.previous');
    const helperFile = join(dir, 'update.ps1');
    const resultFile = join(dir, 'result.json');
    writeFileSync(target, '@echo off\r\necho old\r\n');
    writeFileSync(binaryTemp, '@echo off\r\nif "%1"=="--version" echo 0.16.0\r\n');
    writeFileSync(helperFile, windowsReplacementScript());

    const result = runWindowsHelper({
      helperFile,
      target,
      binaryTemp,
      backup,
      resultFile,
      expectedVersion: '0.16.0',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('0.16.0');
    expect(readResult(resultFile)).toMatchObject({ ok: true, version: '0.16.0' });
  }, 20_000);

  test('the Windows helper restores the previous command after failed verification', () => {
    if (process.platform !== 'win32') return;
    dir = makeTempDir();
    const target = join(dir, 'showtail.cmd');
    const binaryTemp = join(dir, 'showtail.tmp');
    const backup = join(dir, 'showtail.previous');
    const helperFile = join(dir, 'update.ps1');
    const resultFile = join(dir, 'result.json');
    writeFileSync(target, '@echo off\r\necho old\r\n');
    writeFileSync(binaryTemp, '@echo off\r\necho wrong-version\r\n');
    writeFileSync(helperFile, windowsReplacementScript());

    const result = runWindowsHelper({
      helperFile,
      target,
      binaryTemp,
      backup,
      resultFile,
      expectedVersion: '0.16.0',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('echo old');
    expect(readResult(resultFile)).toMatchObject({ ok: false, version: '0.16.0' });
  }, 20_000);

  test('the Windows helper preserves an existing extension when its refresh fails', () => {
    if (process.platform !== 'win32') return;
    dir = makeTempDir();
    const target = join(dir, 'showtail.cmd');
    const binaryTemp = join(dir, 'showtail.tmp');
    const backup = join(dir, 'showtail.previous');
    const helperFile = join(dir, 'update.ps1');
    const resultFile = join(dir, 'result.json');
    const vsixTarget = join(dir, 'showtail.vsix');
    const vsixTemp = join(dir, 'showtail-vsix.tmp');
    writeFileSync(target, '@echo off\r\necho old\r\n');
    writeFileSync(binaryTemp, '@echo off\r\nif "%1"=="--version" echo 0.16.0\r\n');
    writeFileSync(vsixTarget, 'old extension');
    writeFileSync(vsixTemp, 'new extension');
    writeFileSync(helperFile, windowsReplacementScript());

    const result = runWindowsHelper({
      helperFile,
      target,
      binaryTemp,
      backup,
      resultFile,
      expectedVersion: '0.16.0',
      vsixTemp,
      vsixTarget,
      vsixBackup: join(dir, 'missing-parent', 'showtail.vsix.previous'),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('0.16.0');
    expect(readFileSync(vsixTarget, 'utf8')).toBe('old extension');
    expect(readResult(resultFile)).toMatchObject({ ok: true, version: '0.16.0' });
    expect(String(readResult(resultFile).message)).toContain(
      'editor extension was not updated',
    );
  }, 20_000);

  test('the Windows launcher survives after its Bun caller exits', async () => {
    if (process.platform !== 'win32') return;
    dir = makeTempDir();
    const workDir = join(dir, "student's update with spaces");
    mkdirSync(workDir);
    const target = join(workDir, 'showtail.cmd');
    const binaryTemp = join(workDir, 'showtail.tmp');
    const backup = join(workDir, 'showtail.previous');
    const helperFile = join(workDir, 'update.ps1');
    const resultFile = join(workDir, 'result.json');
    const launcherFile = join(workDir, 'launch.ts');
    writeFileSync(target, '@echo off\r\necho old\r\n');
    writeFileSync(binaryTemp, '@echo off\r\nif "%1"=="--version" echo 0.16.0\r\n');
    writeFileSync(
      launcherFile,
      `import { launchWindowsReplacement } from ${JSON.stringify(
        new URL('../src/core/selfUpdate.ts', import.meta.url).href,
      )};
await launchWindowsReplacement(${JSON.stringify({
        parentPid: 2_147_483_647,
        target,
        binaryTemp,
        backup,
        expectedVersion: '0.16.0',
        vsixTarget: join(workDir, 'showtail.vsix'),
        vsixBackup: join(workDir, 'showtail-vsix.previous'),
        resultFile,
        helperFile,
      })});
`,
    );

    const launched = spawnSync(process.execPath, [launcherFile], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (launched.status !== 0) {
      throw new Error(
        `Launcher fixture failed (${launched.status}): ${launched.stderr || launched.stdout}`,
      );
    }
    await waitForFile(resultFile);
    expect(readFileSync(target, 'utf8')).toContain('0.16.0');
    expect(readResult(resultFile)).toMatchObject({ ok: true, version: '0.16.0' });
  }, 20_000);
});

function runWindowsHelper(options: {
  helperFile: string;
  target: string;
  binaryTemp: string;
  backup: string;
  resultFile: string;
  expectedVersion: string;
  vsixTemp?: string;
  vsixTarget?: string;
  vsixBackup?: string;
}) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.helperFile,
      '-ParentPid',
      '2147483647',
      '-Target',
      options.target,
      '-BinaryTemp',
      options.binaryTemp,
      '-Backup',
      options.backup,
      '-ExpectedVersion',
      options.expectedVersion,
      '-VsixTemp',
      options.vsixTemp ?? '',
      '-VsixTarget',
      options.vsixTarget ?? join(dirname(options.target), 'showtail.vsix'),
      '-VsixBackup',
      options.vsixBackup ?? join(dirname(options.target), 'showtail.vsix.previous'),
      '-ResultFile',
      options.resultFile,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

function readResult(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<
    string,
    unknown
  >;
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${file}.`);
}
