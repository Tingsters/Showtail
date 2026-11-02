/** User-wide preferences and capture consent, stored beside the central history. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataHome, dataPath, ensureDataHome } from './dataHome.ts';
import { readJson, writeJson } from './storage.ts';
import type { HistorySettings } from './history.ts';

export interface GlobalConfig {
  version: number;
  captureEnabled?: boolean;
  captureSince?: string;
  captureResumedAt?: string;
  setupCompletedAt?: string;
  autoConnectDisabledTools?: string[];
  settings?: HistorySettings;
  autoOpenReport?: 'always' | 'never' | 'ask';
  update?: {
    automaticChecks?: boolean;
    lastAttemptedAt?: string;
    lastCheckedAt?: string;
    latestVersion?: string;
    lastNotifiedVersion?: string;
    lastNotifiedAt?: string;
  };
}
export const showtailHome = dataHome;
export function globalConfigPath(): string {
  return dataPath('config.json');
}
export function globalConfigExists(): boolean {
  return existsSync(globalConfigPath());
}
export function readGlobalConfig(): GlobalConfig {
  const path = globalConfigPath();
  if (!existsSync(path)) return { version: 2 };
  let value: GlobalConfig;
  try {
    value = readJson<GlobalConfig>(path);
  } catch {
    return { version: 2 };
  }
  if (!value || typeof value !== 'object') return { version: 2 };
  if (value.version > 2)
    throw new Error(
      'CONFIG_NEWER_THAN_BINARY: update Showtail before changing this configuration.',
    );
  return value;
}

let lockDepth = 0;
const waiter = new Int32Array(new SharedArrayBuffer(4));
function locked<T>(fn: () => T): T {
  if (lockDepth) return fn();
  ensureDataHome();
  const path = dataPath('config.lock');
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 4_000;
  while (true) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = Number(readFileSync(path, 'utf8').split(':')[0]);
        let alive = true;
        try {
          process.kill(owner, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (!alive && Date.now() - statSync(path).mtimeMs > 1_000) {
          unlinkSync(path);
          continue;
        }
      } catch {
        /* A concurrent writer may have released it. */
      }
      if (Date.now() >= deadline)
        throw new Error(
          'CONFIG_BUSY: another Showtail command is changing preferences; retry.',
        );
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
  lockDepth++;
  try {
    return fn();
  } finally {
    lockDepth--;
    try {
      if (readFileSync(path, 'utf8') === token) unlinkSync(path);
    } catch {
      /* Do not delete another owner's lock. */
    }
  }
}
export function writeGlobalConfig(config: GlobalConfig): void {
  locked(() => {
    readGlobalConfig();
    writeJson(globalConfigPath(), { ...config, version: 2 });
  });
}

export function toolCaptureConsentPath(tool: string): string {
  return dataPath('capture-consent', `tool-${encodeURIComponent(tool)}.json`);
}
interface Consent {
  version: 1;
  tool: string;
  capture: 'enabled' | 'disabled';
  enabledAt?: string;
}
function readConsent(
  tool: string,
): { disabled: boolean; enabledAt?: string } | undefined {
  const path = toolCaptureConsentPath(tool);
  if (!existsSync(path)) return undefined;
  try {
    const value = readJson<Consent>(path);
    if (
      value.version === 1 &&
      value.tool === tool &&
      value.capture === 'enabled' &&
      value.enabledAt &&
      Number.isFinite(Date.parse(value.enabledAt))
    )
      return { disabled: false, enabledAt: value.enabledAt };
  } catch {
    /* An unreadable or malformed consent marker must fail closed. */
  }
  return { disabled: true };
}
export function toolCaptureGloballyDisabled(tool: string): boolean {
  return readConsent(tool)?.disabled ?? false;
}
export function toolCaptureEnabledAt(tool: string): string | undefined {
  return readConsent(tool)?.enabledAt;
}
export function disableToolCapture(tool: string): void {
  writeJson(toolCaptureConsentPath(tool), {
    version: 1,
    tool,
    capture: 'disabled',
  } satisfies Consent);
}
export function enableToolCapture(tool: string, at = new Date().toISOString()): void {
  const current = readConsent(tool);
  writeJson(toolCaptureConsentPath(tool), {
    version: 1,
    tool,
    capture: 'enabled',
    enabledAt: current?.disabled === false ? current.enabledAt : at,
  } satisfies Consent);
}
export function disableToolAutoConnect(tool: string): void {
  locked(() => {
    const cfg = readGlobalConfig();
    writeJson(globalConfigPath(), {
      ...cfg,
      version: 2,
      autoConnectDisabledTools: [
        ...new Set([...(cfg.autoConnectDisabledTools ?? []), tool]),
      ],
    });
  });
}
export function enableToolAutoConnect(tool: string): void {
  locked(() => {
    const cfg = readGlobalConfig();
    writeJson(globalConfigPath(), {
      ...cfg,
      version: 2,
      autoConnectDisabledTools: (cfg.autoConnectDisabledTools ?? []).filter(
        (t) => t !== tool,
      ),
    });
  });
}
