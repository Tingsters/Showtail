/** Cached, best-effort automatic update checks. */
import { readGlobalConfig, writeGlobalConfig } from './globalConfig.ts';
import { fetchLatestRelease, isNewerVersion, type FetchFn } from './releases.ts';
import { SHOWTAIL_VERSION } from './version.ts';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedUpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
}

export interface PassiveUpdateOptions {
  command: string;
  json?: boolean;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  now?: Date;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  ci?: boolean;
  disabledByEnv?: boolean;
}

const PASSIVE_EXCLUSIONS = new Set([
  'artifact',
  'capabilities',
  'hook',
  'log',
  'matrix',
  'projects',
  'status',
  'update',
  'verify',
]);

/** Read the cached update status without performing network I/O. */
export function cachedUpdateStatus(
  currentVersion: string = SHOWTAIL_VERSION,
): CachedUpdateStatus {
  const update = readGlobalConfig().update;
  const latestVersion = validVersion(update?.latestVersion)
    ? update!.latestVersion
    : undefined;
  return {
    currentVersion,
    ...(latestVersion ? { latestVersion } : {}),
    updateAvailable: latestVersion
      ? isNewerVersion(latestVersion, currentVersion)
      : false,
    ...(update?.lastCheckedAt ? { checkedAt: update.lastCheckedAt } : {}),
  };
}

/** Persistently enable or disable passive update checks. */
export function setAutomaticUpdateChecks(enabled: boolean): void {
  const cfg = readGlobalConfig();
  writeGlobalConfig({
    ...cfg,
    update: { ...cfg.update, automaticChecks: enabled },
  });
}

/** Whether an automatic check is allowed in this command context. */
export function passiveUpdateCheckAllowed(options: PassiveUpdateOptions): boolean {
  if (options.disabledByEnv ?? Boolean(process.env.SHOWTAIL_DISABLE_UPDATE_CHECK))
    return false;
  if (options.ci ?? Boolean(process.env.CI)) return false;
  if (readGlobalConfig().update?.automaticChecks === false) return false;
  if (options.json || PASSIVE_EXCLUSIONS.has(options.command)) return false;
  return (
    (options.stdinIsTTY ?? process.stdin.isTTY ?? false) &&
    (options.stderrIsTTY ?? process.stderr.isTTY ?? false)
  );
}

/**
 * Check when due and return a throttled, neutral reminder. All failures are
 * deliberately silent so update discovery can never disrupt a real command.
 */
export async function passiveUpdateNotice(
  options: PassiveUpdateOptions,
): Promise<string | null> {
  if (!passiveUpdateCheckAllowed(options)) return null;
  const now = options.now ?? new Date();
  try {
    if (updateCheckIsDue(now)) {
      await refreshCachedUpdate({
        now,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        timeoutMs: options.timeoutMs ?? 900,
      });
    }
    return claimUpdateReminder(now);
  } catch {
    noteFailedAttempt(now);
    return claimUpdateReminder(now);
  }
}

/** Refresh the cached latest release. Explicit checks use this with a longer timeout. */
export async function refreshCachedUpdate(
  options: {
    now?: Date;
    fetchFn?: FetchFn;
    timeoutMs?: number;
  } = {},
): Promise<CachedUpdateStatus> {
  const now = options.now ?? new Date();
  const release = await fetchLatestRelease({
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    timeoutMs: options.timeoutMs,
  });
  recordLatestRelease(release.version, now);
  return cachedUpdateStatus();
}

/** Store a release discovered by an explicit or automatic check. */
export function recordLatestRelease(version: string, now: Date = new Date()): void {
  try {
    const cfg = readGlobalConfig();
    writeGlobalConfig({
      ...cfg,
      update: {
        ...cfg.update,
        lastAttemptedAt: now.toISOString(),
        lastCheckedAt: now.toISOString(),
        latestVersion: version,
      },
    });
  } catch {
    // Release discovery and explicit updates must not depend on a writable cache.
  }
}

function updateCheckIsDue(now: Date): boolean {
  const update = readGlobalConfig().update;
  const checked = update?.lastCheckedAt ? Date.parse(update.lastCheckedAt) : Number.NaN;
  const attempted = update?.lastAttemptedAt
    ? Date.parse(update.lastAttemptedAt)
    : Number.NaN;
  const anchor = Math.max(
    Number.isFinite(checked) ? checked : Number.NEGATIVE_INFINITY,
    Number.isFinite(attempted) ? attempted : Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(anchor)) return true;
  const elapsed = now.getTime() - anchor;
  const failedAttemptIsNewest =
    Number.isFinite(attempted) && (!Number.isFinite(checked) || attempted > checked);
  const interval = failedAttemptIsNewest
    ? UPDATE_RETRY_INTERVAL_MS
    : UPDATE_CHECK_INTERVAL_MS;
  return !Number.isFinite(elapsed) || elapsed >= interval;
}

function claimUpdateReminder(now: Date): string | null {
  const status = cachedUpdateStatus();
  if (!status.updateAvailable || !status.latestVersion) return null;
  const cfg = readGlobalConfig();
  const state = cfg.update;
  const sameRelease = state?.lastNotifiedVersion === status.latestVersion;
  const lastNotified = state?.lastNotifiedAt
    ? Date.parse(state.lastNotifiedAt)
    : Number.NaN;
  if (
    sameRelease &&
    Number.isFinite(lastNotified) &&
    now.getTime() - lastNotified < UPDATE_REMINDER_INTERVAL_MS
  ) {
    return null;
  }
  try {
    writeGlobalConfig({
      ...cfg,
      update: {
        ...state,
        lastNotifiedVersion: status.latestVersion,
        lastNotifiedAt: now.toISOString(),
      },
    });
  } catch {
    // Without a durable throttle, staying silent is less intrusive than repeating.
    return null;
  }
  return (
    `A newer Showtail is available: ${status.currentVersion} -> ${status.latestVersion}.\n` +
    'Run `showtail update` when convenient.'
  );
}

function noteFailedAttempt(now: Date): void {
  try {
    const cfg = readGlobalConfig();
    writeGlobalConfig({
      ...cfg,
      update: { ...cfg.update, lastAttemptedAt: now.toISOString() },
    });
  } catch {
    // A broken cache must never make a normal command fail.
  }
}

function validVersion(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}
