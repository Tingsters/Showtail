/** Explicit `showtail update` command. */
import { emitJson } from '../core/output.ts';
import { ShowtailError } from '../core/errors.ts';
import {
  fetchLatestRelease,
  isNewerVersion,
  type ShowtailRelease,
} from '../core/releases.ts';
import {
  installShowtailRelease,
  isStandaloneExecutable,
  type InstallReleaseResult,
} from '../core/selfUpdate.ts';
import { recordLatestRelease, setAutomaticUpdateChecks } from '../core/updateCheck.ts';
import { SHOWTAIL_VERSION } from '../core/version.ts';

export interface UpdateOptions {
  check?: boolean;
  json?: boolean;
  autoCheck?: string;
  currentVersion?: string;
  executablePath?: string;
  fetchRelease?: () => Promise<ShowtailRelease>;
  installRelease?: (release: ShowtailRelease) => Promise<InstallReleaseResult>;
  now?: Date;
}

type UpdateStatus = 'current' | 'available' | 'updated' | 'pending' | 'manual';

export interface UpdateCommandResult {
  status: UpdateStatus | 'configured';
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  automaticChecks?: boolean;
  target?: string;
  extensionUpdated?: boolean;
  warning?: string;
}

/** Check for and, unless `--check` is set, install the latest stable release. */
export async function runUpdate(
  options: UpdateOptions = {},
): Promise<UpdateCommandResult> {
  if (options.autoCheck !== undefined) {
    const enabled = parseAutoCheck(options.autoCheck);
    setAutomaticUpdateChecks(enabled);
    const result = { status: 'configured' as const, automaticChecks: enabled };
    if (options.json) {
      emitJson(result);
    } else {
      console.log(`Automatic update checks are ${enabled ? 'on' : 'off'}.`);
    }
    return result;
  }

  const currentVersion = options.currentVersion ?? SHOWTAIL_VERSION;
  if (!options.json) console.log('Checking for Showtail updates...');
  let release: ShowtailRelease;
  try {
    release = await (
      options.fetchRelease ?? (() => fetchLatestRelease({ timeoutMs: 15_000 }))
    )();
  } catch (error) {
    throw new ShowtailError(`Could not check for updates: ${errorMessage(error)}`);
  }
  recordLatestRelease(release.version, options.now);

  if (!isNewerVersion(release.version, currentVersion)) {
    const result: UpdateCommandResult = {
      status: 'current',
      currentVersion,
      latestVersion: release.version,
      updateAvailable: false,
    };
    printResult(options.json, result);
    return result;
  }

  if (options.check) {
    const result: UpdateCommandResult = {
      status: 'available',
      currentVersion,
      latestVersion: release.version,
      updateAvailable: true,
    };
    printResult(options.json, result);
    return result;
  }

  const executablePath =
    options.executablePath ?? process.env.SHOWTAIL_UPDATE_TARGET ?? process.execPath;
  if (!isStandaloneExecutable(executablePath) && !options.installRelease) {
    const result: UpdateCommandResult = {
      status: 'manual',
      currentVersion,
      latestVersion: release.version,
      updateAvailable: true,
    };
    printResult(options.json, result);
    return result;
  }

  if (!options.json) {
    console.log(`Showtail ${release.version} is available. You have ${currentVersion}.`);
    console.log('Downloading and verifying the update...');
  }

  let installed: InstallReleaseResult;
  try {
    installed = await (
      options.installRelease ??
      ((candidate) => installShowtailRelease(candidate, { executablePath }))
    )(release);
  } catch (error) {
    throw new ShowtailError(
      `Update failed: ${errorMessage(error)} The existing installation was left in place.`,
    );
  }

  const result: UpdateCommandResult = {
    status: installed.status,
    currentVersion,
    latestVersion: release.version,
    updateAvailable: installed.status === 'manual',
    ...(installed.target ? { target: installed.target } : {}),
    ...(installed.extensionUpdated !== undefined
      ? { extensionUpdated: installed.extensionUpdated }
      : {}),
    ...(installed.warning ? { warning: installed.warning } : {}),
  };
  printResult(options.json, result);
  return result;
}

function parseAutoCheck(value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new ShowtailError('--auto-check must be either "on" or "off".');
}

function printResult(json: boolean | undefined, result: UpdateCommandResult): void {
  if (json) {
    emitJson(result);
    return;
  }
  switch (result.status) {
    case 'configured':
      return;
    case 'current':
      console.log(`Showtail ${result.currentVersion!} is up to date.`);
      break;
    case 'available':
      console.log(
        `Showtail ${result.latestVersion!} is available. You have ${result.currentVersion!}.`,
      );
      console.log('Run `showtail update` when convenient.');
      break;
    case 'manual':
      console.log(
        `Showtail ${result.latestVersion!} is available. You have ${result.currentVersion!}.`,
      );
      console.log(
        'This copy of Showtail is running from source, so it was not replaced.',
      );
      console.log('Pull the latest repository changes and rebuild it with Bun.');
      break;
    case 'pending':
      console.log(`Downloaded and verified Showtail ${result.latestVersion!}.`);
      console.log(
        'Windows will finish replacing the executable after this command exits.',
      );
      break;
    case 'updated':
      console.log(
        `Updated Showtail from ${result.currentVersion!} to ${result.latestVersion!}.`,
      );
      break;
  }
  if (result.warning) console.log(`Note: ${result.warning}`);
  if (result.status === 'updated' || result.status === 'pending') {
    console.log(
      'Capture integrations will refresh automatically the next time Showtail runs.',
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
