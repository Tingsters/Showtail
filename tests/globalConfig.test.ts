import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeTempDir } from './helpers.ts';
import {
  disableToolAutoConnect,
  disableToolCapture,
  enableToolAutoConnect,
  enableToolCapture,
  globalConfigPath,
  readGlobalConfig,
  showtailHome,
  toolCaptureConsentPath,
  toolCaptureEnabledAt,
  toolCaptureGloballyDisabled,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';

describe('central preferences and consent', () => {
  const original = process.env.SHOWTAIL_HOME;
  let dir: string | undefined;
  const home = () => {
    dir = makeTempDir();
    process.env.SHOWTAIL_HOME = dir;
    return dir;
  };
  afterEach(() => {
    if (original === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = original;
    if (dir) cleanup(dir);
    dir = undefined;
  });
  test('a read-only probe does not create storage or turn capture on', () => {
    const path = home();
    expect(readGlobalConfig()).toEqual({ version: 2 });
    expect(existsSync(join(path, 'config.json'))).toBe(false);
    expect(showtailHome()).toBe(path);
  });
  test('settings and update preferences round-trip in the same folder', () => {
    const path = home();
    writeGlobalConfig({
      version: 2,
      captureEnabled: true,
      settings: { captureToolOutput: false },
      update: { automaticChecks: false },
    });
    expect(globalConfigPath()).toBe(join(path, 'config.json'));
    expect(readGlobalConfig()).toMatchObject({
      captureEnabled: true,
      update: { automaticChecks: false },
    });
  });
  test('corrupt configuration fails closed for automatic capture', () => {
    const path = home();
    writeFileSync(join(path, 'config.json'), '{broken');
    expect(readGlobalConfig().captureEnabled).not.toBe(true);
  });
  test('a future configuration is never silently overwritten', () => {
    const path = home();
    writeFileSync(join(path, 'config.json'), '{"version":999}');
    expect(() => writeGlobalConfig({ version: 2 })).toThrow('CONFIG_NEWER_THAN_BINARY');
  });
  test('per-tool consent survives unrelated preference updates', () => {
    home();
    disableToolCapture('codex');
    writeGlobalConfig({ version: 2, captureEnabled: true });
    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
    expect(toolCaptureGloballyDisabled('claude')).toBe(false);
  });
  test('refresh preserves the original resume boundary and reconnect advances it', () => {
    home();
    enableToolCapture('codex', '2026-01-01T00:00:00Z');
    enableToolCapture('codex', '2026-02-01T00:00:00Z');
    expect(toolCaptureEnabledAt('codex')).toBe('2026-01-01T00:00:00Z');
    disableToolCapture('codex');
    enableToolCapture('codex', '2026-03-01T00:00:00Z');
    expect(toolCaptureEnabledAt('codex')).toBe('2026-03-01T00:00:00Z');
  });
  test('a malformed consent marker cannot restore capture', () => {
    home();
    enableToolCapture('codex');
    writeFileSync(toolCaptureConsentPath('codex'), '{broken');
    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
  });
  test('automatic connection opt-outs persist until explicit reconnect', () => {
    home();
    disableToolAutoConnect('codex');
    disableToolAutoConnect('codex');
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual(['codex']);
    enableToolAutoConnect('codex');
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual([]);
  });
});
