/** Download, verify, and safely replace a standalone Showtail installation. */
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256OfFile } from './hash.ts';
import { showtailHome } from './globalConfig.ts';
import {
  binaryAssetName,
  releaseDownloadUrlIsTrusted,
  requireReleaseAsset,
  type ReleaseAsset,
  type FetchFn,
  type ShowtailRelease,
} from './releases.ts';

const DOWNLOAD_TIMEOUT_MS = 60_000;
const UPDATE_RESULT_FILE = 'update-result.json';

export interface InstallReleaseOptions {
  executablePath?: string;
  runningExecutablePath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchFn?: FetchFn;
  verifyExecutable?: (path: string, version: string) => boolean | Promise<boolean>;
  launchWindowsHelper?: (options: WindowsReplacementOptions) => Promise<void>;
}

export interface InstallReleaseResult {
  status: 'updated' | 'pending' | 'manual';
  target?: string;
  extensionUpdated?: boolean;
  warning?: string;
}

export interface WindowsReplacementOptions {
  parentPid: number;
  target: string;
  binaryTemp: string;
  backup: string;
  expectedVersion: string;
  vsixTemp?: string;
  vsixTarget: string;
  vsixBackup: string;
  resultFile: string;
  helperFile: string;
}

/** Bun/Node source runs must never replace their runtime executable. */
export function isStandaloneExecutable(
  executablePath: string = process.execPath,
): boolean {
  // Release guidance can contain paths for a different OS than the one running
  // this check, so normalize Windows separators before asking the host parser.
  const name = basename(executablePath.replace(/\\/g, '/')).toLowerCase();
  return !['bun', 'bun.exe', 'node', 'node.exe'].includes(name);
}

/** Install a verified release over the currently-running standalone binary. */
export async function installShowtailRelease(
  release: ShowtailRelease,
  options: InstallReleaseOptions = {},
): Promise<InstallReleaseResult> {
  const platform = options.platform ?? process.platform;
  const executablePath =
    options.executablePath ?? process.env.SHOWTAIL_UPDATE_TARGET ?? process.execPath;
  if (!isStandaloneExecutable(executablePath)) return { status: 'manual' };

  const binaryAsset = requireReleaseAsset(
    release,
    binaryAssetName(platform, options.arch ?? process.arch),
  );
  const vsixAsset = release.assets.find((asset) => asset.name === 'showtail.vsix');
  const targetDir = dirname(executablePath);
  const token = `${process.pid}-${randomUUID()}`;
  const binaryTemp = join(targetDir, `.showtail-update-${token}.tmp`);
  const backup = join(targetDir, `.showtail-update-${token}.previous`);
  const vsixTarget = join(targetDir, 'showtail.vsix');
  const vsixTemp = vsixAsset ? join(targetDir, `.showtail-vsix-${token}.tmp`) : undefined;
  const vsixBackup = join(targetDir, `.showtail-vsix-${token}.previous`);

  await mkdir(targetDir, { recursive: true });
  let extensionUpdated = false;
  let warning: string | undefined;
  let helperOwnsTemps = false;
  try {
    await downloadVerifiedAsset(binaryAsset, binaryTemp, release, options.fetchFn);
    if (platform !== 'win32') await chmod(binaryTemp, 0o755);

    if (vsixAsset && vsixTemp) {
      try {
        await downloadVerifiedAsset(vsixAsset, vsixTemp, release, options.fetchFn);
      } catch (error) {
        warning = `The bundled editor extension was not updated: ${errorMessage(error)}`;
        await rm(vsixTemp, { force: true });
      }
    }

    if (
      platform === 'win32' &&
      samePath(
        executablePath,
        options.runningExecutablePath ?? process.execPath,
        platform,
      )
    ) {
      const helperFile = join(targetDir, `.showtail-update-${token}.ps1`);
      const resultDir = showtailHome();
      await mkdir(resultDir, { recursive: true });
      await (options.launchWindowsHelper ?? launchWindowsReplacement)({
        parentPid: process.pid,
        target: executablePath,
        binaryTemp,
        backup,
        expectedVersion: release.version,
        ...(vsixTemp && existsSync(vsixTemp) ? { vsixTemp } : {}),
        vsixTarget,
        vsixBackup,
        resultFile: join(resultDir, UPDATE_RESULT_FILE),
        helperFile,
      });
      helperOwnsTemps = true;
      return {
        status: 'pending',
        target: executablePath,
        ...(warning ? { warning } : {}),
      };
    }

    await replaceExecutableImmediately({
      target: executablePath,
      binaryTemp,
      backup,
      expectedVersion: release.version,
      platform,
      verifyExecutable: options.verifyExecutable,
    });
    if (vsixTemp && existsSync(vsixTemp)) {
      try {
        await replaceOptionalFile(vsixTemp, vsixTarget);
        extensionUpdated = true;
      } catch (error) {
        warning = `Showtail was updated, but the bundled editor extension was not: ${errorMessage(error)}`;
      }
    }
    return {
      status: 'updated',
      target: executablePath,
      extensionUpdated,
      ...(warning ? { warning } : {}),
    };
  } finally {
    if (!helperOwnsTemps) {
      await rm(binaryTemp, { force: true }).catch(() => undefined);
      if (vsixTemp) await rm(vsixTemp, { force: true }).catch(() => undefined);
    }
  }
}

async function downloadVerifiedAsset(
  asset: ReleaseAsset,
  destination: string,
  release: ShowtailRelease,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  if (!releaseDownloadUrlIsTrusted(asset.url)) {
    throw new Error(`Refusing an untrusted release URL for ${asset.name}.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchFn(asset.url, {
      headers: { 'User-Agent': 'Showtail-updater' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Download failed for ${asset.name} (${response.status}).`);
    }
    await Bun.write(destination, response);
  } finally {
    clearTimeout(timer);
  }
  const info = await stat(destination);
  if (info.size !== asset.size) {
    throw new Error(`Downloaded ${asset.name} has the wrong size.`);
  }
  const expected =
    asset.sha256 ?? (await hashFromChecksumManifest(release, asset, fetchFn));
  const actual = await sha256OfFile(destination);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`SHA-256 verification failed for ${asset.name}.`);
  }
}

async function hashFromChecksumManifest(
  release: ShowtailRelease,
  asset: ReleaseAsset,
  fetchFn: FetchFn,
): Promise<string> {
  const manifest = requireReleaseAsset(release, 'SHA256SUMS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let text: string;
  try {
    const response = await fetchFn(manifest.url, {
      headers: { 'User-Agent': 'Showtail-updater' },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Could not download SHA256SUMS (${response.status}).`);
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().endsWith(`  ${asset.name}`));
  const match = line ? /^([a-f0-9]{64})\s{2}(.+)$/i.exec(line.trim()) : null;
  if (!match || match[2] !== asset.name) {
    throw new Error(`SHA256SUMS does not include ${asset.name}.`);
  }
  return match[1]!.toLowerCase();
}

async function replaceExecutableImmediately(options: {
  target: string;
  binaryTemp: string;
  backup: string;
  expectedVersion: string;
  platform: NodeJS.Platform;
  verifyExecutable?: (path: string, version: string) => boolean | Promise<boolean>;
}): Promise<void> {
  await rm(options.backup, { force: true });
  await rename(options.target, options.backup);
  try {
    await rename(options.binaryTemp, options.target);
    const verified = options.verifyExecutable
      ? await options.verifyExecutable(options.target, options.expectedVersion)
      : verifyExecutableVersion(options.target, options.expectedVersion);
    if (!verified)
      throw new Error('The updated executable did not report the expected version.');
    await rm(options.backup, { force: true });
  } catch (error) {
    await rm(options.target, { force: true }).catch(() => undefined);
    await rename(options.backup, options.target).catch(() => undefined);
    throw error;
  }
}

function verifyExecutableVersion(target: string, expectedVersion: string): boolean {
  const result = spawnSync(target, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      SHOWTAIL_DISABLE_FIRST_RUN: '1',
      SHOWTAIL_DISABLE_UPDATE_CHECK: '1',
    },
  });
  return result.status === 0 && result.stdout.trim() === expectedVersion;
}

async function replaceOptionalFile(source: string, target: string): Promise<void> {
  const old = `${target}.previous`;
  await rm(old, { force: true });
  if (existsSync(target)) await rename(target, old);
  try {
    await rename(source, target);
    await rm(old, { force: true }).catch(() => undefined);
  } catch (error) {
    if (!existsSync(target) && existsSync(old)) await rename(old, target);
    throw error;
  }
}

/** Launch a detached helper because Windows cannot replace the running executable. */
export async function launchWindowsReplacement(
  options: WindowsReplacementOptions,
): Promise<void> {
  await writeFile(options.helperFile, windowsReplacementScript(), 'utf8');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    options.helperFile,
    '-ParentPid',
    String(options.parentPid),
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
    options.vsixTarget,
    '-VsixBackup',
    options.vsixBackup,
    '-ResultFile',
    options.resultFile,
  ];
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn('powershell.exe', args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', rejectPromise);
      child.once('spawn', () => {
        child.unref();
        resolvePromise();
      });
    });
  } catch (error) {
    await rm(options.helperFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** PowerShell helper source kept separate so its rollback behavior is unit-testable. */
export function windowsReplacementScript(): string {
  return String.raw`param(
  [int]$ParentPid,
  [string]$Target,
  [string]$BinaryTemp,
  [string]$Backup,
  [string]$ExpectedVersion,
  [string]$VsixTemp,
  [string]$VsixTarget,
  [string]$VsixBackup,
  [string]$ResultFile
)
$ErrorActionPreference = 'Stop'
function Write-UpdateResult([bool]$Ok, [string]$Message) {
  $result = @{ ok = $Ok; version = $ExpectedVersion; message = $Message }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
}
try {
  for ($attempt = 0; $attempt -lt 300; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw 'Timed out waiting for the old Showtail process to exit.'
  }
  Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $Target -Destination $Backup -Force
  try {
    Move-Item -LiteralPath $BinaryTemp -Destination $Target -Force
    $reported = (& $Target --version | Out-String).Trim()
    if ($reported -ne $ExpectedVersion) {
      throw "Updated executable reported $reported instead of $ExpectedVersion."
    }
    $vsixWarning = ''
    if ($VsixTemp -and (Test-Path -LiteralPath $VsixTemp)) {
      try {
        Remove-Item -LiteralPath $VsixBackup -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $VsixTarget) {
          Move-Item -LiteralPath $VsixTarget -Destination $VsixBackup -Force
        }
        try {
          Move-Item -LiteralPath $VsixTemp -Destination $VsixTarget -Force
          Remove-Item -LiteralPath $VsixBackup -Force -ErrorAction SilentlyContinue
        } catch {
          Remove-Item -LiteralPath $VsixTarget -Force -ErrorAction SilentlyContinue
          if (Test-Path -LiteralPath $VsixBackup) {
            Move-Item -LiteralPath $VsixBackup -Destination $VsixTarget -Force
          }
          throw
        }
      } catch {
        $vsixWarning = " The bundled editor extension was not updated: $($_.Exception.Message)"
      }
    }
    Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
    Write-UpdateResult $true "Showtail updated to $ExpectedVersion.$vsixWarning"
  } catch {
    Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Backup) {
      Move-Item -LiteralPath $Backup -Destination $Target -Force
    }
    throw
  }
} catch {
  Write-UpdateResult $false $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $BinaryTemp -Force -ErrorAction SilentlyContinue
  if ($VsixTemp) { Remove-Item -LiteralPath $VsixTemp -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}

/** Surface one Windows helper result, then remove its machine-local status file. */
export function consumeUpdateResultNotice(): string | null {
  const resultFile = join(showtailHome(), UPDATE_RESULT_FILE);
  if (!existsSync(resultFile)) return null;
  try {
    const raw = readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
    const result = JSON.parse(raw) as {
      ok?: boolean;
      version?: string;
      message?: string;
    };
    if (result.ok && result.version) {
      return result.message ?? `Showtail updated to ${result.version}.`;
    }
    return `Showtail could not finish its update: ${result.message ?? 'unknown error'}`;
  } catch {
    return 'Showtail could not read the result of its previous update.';
  } finally {
    rmSync(resultFile, { force: true });
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
