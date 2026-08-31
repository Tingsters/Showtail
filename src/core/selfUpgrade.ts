import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SHOWTAIL_VERSION } from './version.ts';

const DEFAULT_REPO = 'Tingsters/Showtail';
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

export interface SelfUpgradeOptions {
  /** Overrides used by tests and downstream builds. */
  targetPath?: string;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  repo?: string;
  fetchFn?: typeof fetch;
  verifyDownloaded?: (path: string, expectedVersion: string) => void;
  refreshInstalledIntegrations?: (path: string) => boolean;
  replaceDownloaded?: (source: string, target: string) => void;
}

export interface SelfUpgradeResult {
  status: 'current' | 'newer' | 'upgraded' | 'pending';
  currentVersion: string;
  latestVersion: string;
  targetPath: string;
  assetName: string;
  extensionUpdated: boolean;
  integrationsRefreshed: boolean;
}

interface ReleaseInfo {
  version: string;
  binaryUrl: string;
  vsixUrl?: string;
}

function parseVersion(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid Showtail release version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare the plain semver triples used by Showtail release tags. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < a.length; i++) {
    const delta = a[i]! - b[i]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

/** Map Node's platform/architecture names to the assets produced by release.yml. */
export function releaseAssetName(
  platform: NodeJS.Platform = hostPlatform(),
  arch: string = hostArch(),
): string {
  if (platform === 'win32') {
    if (arch !== 'x64') throw new Error(`Unsupported Windows architecture: ${arch}`);
    return 'showtail-windows-x64.exe';
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported ${platform} architecture: ${arch}`);
  }
  return `showtail-${platform}-${arch}`;
}

/**
 * Locate the standalone binary. A Bun/source invocation points at the Bun runtime,
 * which must never be replaced by a self-updater.
 */
export function installedExecutablePath(
  executable = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = resolve(executable);
  const expected = platform === 'win32' ? 'showtail.exe' : 'showtail';
  if (basename(target).toLowerCase() !== expected) {
    throw new Error(
      '`showtail upgrade` updates standalone installs only. This copy is running ' +
        `through ${target}; update the Bun/source checkout with its package or git workflow.`,
    );
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Installed Showtail executable was not found at ${target}.`);
  }
  return target;
}

function githubHeaders(authenticated = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Showtail/${SHOWTAIL_VERSION}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = authenticated ? process.env.GITHUB_TOKEN : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function validatedRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  return repo;
}

async function latestRelease(
  repo: string,
  assetName: string,
  fetchFn: typeof fetch,
): Promise<ReleaseInfo> {
  const response = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(true),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Could not check the latest Showtail release (GitHub returned ${response.status}).`,
    );
  }

  const body = (await response.json()) as GitHubRelease;
  if (typeof body.tag_name !== 'string') {
    throw new Error('The latest GitHub release has no valid version tag.');
  }
  const version = body.tag_name.startsWith('v') ? body.tag_name.slice(1) : body.tag_name;
  parseVersion(version);

  const assets = Array.isArray(body.assets) ? (body.assets as GitHubAsset[]) : [];
  const findAsset = (name: string): string | undefined => {
    const asset = assets.find((candidate) => candidate.name === name);
    return typeof asset?.browser_download_url === 'string'
      ? asset.browser_download_url
      : undefined;
  };
  const binaryUrl = findAsset(assetName);
  if (!binaryUrl) {
    throw new Error(`Release v${version} does not include ${assetName}.`);
  }
  const vsixUrl = findAsset('showtail.vsix');
  return { version, binaryUrl, vsixUrl };
}

async function download(
  url: string,
  destination: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const response = await fetchFn(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status}) from ${url}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`Downloaded an empty file from ${url}.`);
  writeFileSync(destination, bytes, { flag: 'wx' });
}

function verifyDownloadedBinary(path: string, expectedVersion: string): void {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, SHOWTAIL_DISABLE_FIRST_RUN: '1' },
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Downloaded Showtail could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Downloaded Showtail failed its version check (exit ${result.status}).`,
    );
  }
  const reported = result.stdout.trim();
  if (reported !== expectedVersion) {
    throw new Error(
      `Downloaded Showtail reported version ${reported || '(empty)'}, expected ${expectedVersion}.`,
    );
  }
}

function replaceFile(source: string, target: string): void {
  renameSync(source, target);
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface WindowsReplacementPaths {
  target: string;
  binaryTemp: string;
  binaryBackup: string;
  vsixTemp: string;
  vsixTarget: string;
  vsixBackup: string;
  parentPid: number;
}

/** Build the detached helper used after Windows releases the running executable. */
export function windowsReplacementScript(paths: WindowsReplacementPaths): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${powershellLiteral(paths.target)}`,
    `$download = ${powershellLiteral(paths.binaryTemp)}`,
    `$backup = ${powershellLiteral(paths.binaryBackup)}`,
    `$vsixDownload = ${powershellLiteral(paths.vsixTemp)}`,
    `$vsixTarget = ${powershellLiteral(paths.vsixTarget)}`,
    `$vsixBackup = ${powershellLiteral(paths.vsixBackup)}`,
    `$parentPid = ${paths.parentPid}`,
    '$binaryStaged = $false',
    '$vsixStaged = $false',
    '$binaryInstalled = $false',
    '$vsixInstalled = $false',
    'try {',
    '  $deadline = [DateTime]::UtcNow.AddSeconds(30)',
    '  while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {',
    "    if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for Showtail to exit.' }",
    '    Start-Sleep -Milliseconds 100',
    '  }',
    '  try {',
    '    Move-Item -LiteralPath $target -Destination $backup -Force',
    '    $binaryStaged = $true',
    '    if (Test-Path -LiteralPath $vsixTarget) {',
    '      Move-Item -LiteralPath $vsixTarget -Destination $vsixBackup -Force',
    '      $vsixStaged = $true',
    '    }',
    '    Move-Item -LiteralPath $download -Destination $target -Force',
    '    $binaryInstalled = $true',
    '    Move-Item -LiteralPath $vsixDownload -Destination $vsixTarget -Force',
    '    $vsixInstalled = $true',
    '    try { & $target setup --first-run --json *> $null } catch { }',
    '    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $vsixBackup -Force -ErrorAction SilentlyContinue',
    '  } catch {',
    '    if ($binaryInstalled) {',
    '      Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue',
    '    }',
    '    if ($vsixInstalled) {',
    '      Remove-Item -LiteralPath $vsixTarget -Force -ErrorAction SilentlyContinue',
    '    }',
    '    if ($binaryStaged -and (Test-Path -LiteralPath $backup)) {',
    '      Move-Item -LiteralPath $backup -Destination $target -Force',
    '    }',
    '    if ($vsixStaged -and (Test-Path -LiteralPath $vsixBackup)) {',
    '      Move-Item -LiteralPath $vsixBackup -Destination $vsixTarget -Force',
    '    }',
    '    throw',
    '  }',
    '} finally {',
    '  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $vsixDownload -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '}',
    '',
  ].join('\r\n');
}

async function scheduleWindowsReplacement(
  target: string,
  binaryTemp: string,
  binaryBackup: string,
  vsixTemp: string,
  vsixTarget: string,
  vsixBackup: string,
): Promise<void> {
  const scriptPath = join(
    dirname(target),
    `.showtail-upgrade-${process.pid}-${randomUUID()}.ps1`,
  );
  writeFileSync(
    scriptPath,
    windowsReplacementScript({
      target,
      binaryTemp,
      binaryBackup,
      vsixTemp,
      vsixTarget,
      vsixBackup,
      parentPid: process.pid,
    }),
    'utf8',
  );

  const systemRoot = process.env.SystemRoot;
  const powershell = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  }).catch((error) => {
    rmSync(scriptPath, { force: true });
    throw error;
  });
}

function refreshIntegrations(target: string): boolean {
  const result = spawnSync(target, ['setup', '--first-run', '--json'], {
    stdio: 'ignore',
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/** Download, verify, and atomically replace a standalone Showtail installation. */
export async function selfUpgrade(
  options: SelfUpgradeOptions = {},
): Promise<SelfUpgradeResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const currentVersion = options.currentVersion ?? SHOWTAIL_VERSION;
  parseVersion(currentVersion);
  const targetPath = installedExecutablePath(options.targetPath, platform);
  const assetName = releaseAssetName(platform, arch);
  const repo = validatedRepo(options.repo ?? process.env.SHOWTAIL_REPO ?? DEFAULT_REPO);
  const fetchFn = options.fetchFn ?? fetch;
  const release = await latestRelease(repo, assetName, fetchFn);
  const comparison = compareVersions(currentVersion, release.version);

  if (comparison >= 0) {
    return {
      status: comparison === 0 ? 'current' : 'newer',
      currentVersion,
      latestVersion: release.version,
      targetPath,
      assetName,
      extensionUpdated: false,
      integrationsRefreshed: false,
    };
  }

  if (!release.vsixUrl) {
    throw new Error(`Release v${release.version} does not include showtail.vsix.`);
  }

  const directory = dirname(targetPath);
  const suffix = `${process.pid}-${randomUUID()}`;
  const binaryTemp = join(
    directory,
    `.showtail-upgrade-${suffix}${platform === 'win32' ? '.exe' : ''}`,
  );
  const binaryBackup = join(directory, `.showtail-upgrade-backup-${suffix}`);
  const vsixTarget = join(directory, 'showtail.vsix');
  const vsixTemp = join(directory, `.showtail-upgrade-${suffix}.vsix`);
  const vsixBackup = join(directory, `.showtail-upgrade-backup-${suffix}.vsix`);
  let keepTemps = false;

  try {
    await download(release.binaryUrl, binaryTemp, fetchFn);
    if (platform !== 'win32') {
      const mode = statSync(targetPath).mode & 0o777;
      chmodSync(binaryTemp, mode | 0o100);
    }
    (options.verifyDownloaded ?? verifyDownloadedBinary)(binaryTemp, release.version);

    await download(release.vsixUrl, vsixTemp, fetchFn);

    if (platform === 'win32') {
      await scheduleWindowsReplacement(
        targetPath,
        binaryTemp,
        binaryBackup,
        vsixTemp,
        vsixTarget,
        vsixBackup,
      );
      keepTemps = true;
      return {
        status: 'pending',
        currentVersion,
        latestVersion: release.version,
        targetPath,
        assetName,
        extensionUpdated: false,
        integrationsRefreshed: false,
      };
    }

    renameSync(targetPath, binaryBackup);

    try {
      if (existsSync(vsixTarget)) renameSync(vsixTarget, vsixBackup);
    } catch (error) {
      renameSync(binaryBackup, targetPath);
      throw error;
    }

    try {
      const replaceDownloaded = options.replaceDownloaded ?? replaceFile;
      replaceDownloaded(binaryTemp, targetPath);
      replaceDownloaded(vsixTemp, vsixTarget);
    } catch (error) {
      rmSync(targetPath, { force: true });
      rmSync(vsixTarget, { force: true });
      renameSync(binaryBackup, targetPath);
      if (existsSync(vsixBackup)) renameSync(vsixBackup, vsixTarget);
      throw error;
    }
    try {
      rmSync(binaryBackup, { force: true });
      rmSync(vsixBackup, { force: true });
    } catch {
      /* The new install is complete; stale backups are safe to remove later. */
    }

    return {
      status: 'upgraded',
      currentVersion,
      latestVersion: release.version,
      targetPath,
      assetName,
      extensionUpdated: true,
      integrationsRefreshed: (
        options.refreshInstalledIntegrations ?? refreshIntegrations
      )(targetPath),
    };
  } finally {
    if (!keepTemps) {
      rmSync(binaryTemp, { force: true });
      rmSync(vsixTemp, { force: true });
    }
  }
}
