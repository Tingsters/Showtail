import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_IDENTITY_CATALOG_VERSION,
  autoInitEnabled,
  detectHistoryUpgrade,
  disableToolAutoConnect,
  disableToolCapture,
  enableToolAutoConnect,
  enableToolCapture,
  globalConfigPath,
  noteKnownProject,
  readGlobalConfig,
  showtailHome,
  toolCaptureConsentPath,
  toolCaptureEnabledAt,
  toolCaptureGloballyDisabled,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('global config (~/.showtail-cli)', () => {
  const original = process.env.SHOWTAIL_HOME;
  let dir: string | undefined;

  /** Point SHOWTAIL_HOME at a throwaway temp dir for the duration of a test. */
  function withTempHome(): string {
    dir = makeTempDir();
    process.env.SHOWTAIL_HOME = dir;
    return dir;
  }

  afterEach(() => {
    if (dir) cleanup(dir);
    dir = undefined;
    if (original === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = original;
  });

  test('defaults to version 1 with auto-init off when no file exists', () => {
    withTempHome();
    expect(readGlobalConfig()).toEqual({ version: 1 });
    expect(autoInitEnabled()).toBe(false);
    expect(toolCaptureGloballyDisabled('codex')).toBe(false);
  });

  test('round-trips a written config', () => {
    withTempHome();
    writeGlobalConfig({
      version: 1,
      autoInit: true,
      setupCompletedAt: '2026-06-20T00:00:00.000Z',
      toolIntegrationGenerations: { codex: '0.16.2:2' },
    });
    expect(autoInitEnabled()).toBe(true);
    expect(readGlobalConfig().setupCompletedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(readGlobalConfig().toolIntegrationGenerations).toEqual({ codex: '0.16.2:2' });
  });

  test('persists versioned trail-keyed identity, basename, and edit-reference history', () => {
    const home = withTempHome();
    const first = join(home, 'projects', 'word_sparkle_old');
    const second = join(home, 'projects', 'word_sparkle');
    const copied = join(home, 'projects', 'word_sparkle_copy');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    mkdirSync(copied, { recursive: true });

    noteKnownProject(first, 'trl_word', {
      configuredName: 'Word Sparkle',
      entrypointBasenames: ['word_sparkle.py'],
      editReferences: [
        {
          ledgerId: 'led_first',
          nativeSessionId: 'native_first',
          segmentId: 'seg_first',
          recordId: 'evt_first',
          path: join(first, 'word_sparkle.py'),
          basename: 'word_sparkle.py',
          sha256: 'a'.repeat(64),
        },
      ],
    });
    noteKnownProject(second, 'trl_word', {
      configuredName: 'Word Sparkle Game',
      entrypointBasenames: ['game.ts'],
      editReferences: [
        {
          ledgerId: 'led_second',
          nativeSessionId: 'native_second',
          recordId: 'evt_second',
          path: join(second, 'game.ts'),
          basename: 'game.ts',
        },
      ],
      conflictPaths: [second, copied],
    });

    const catalog = readGlobalConfig().projectCatalog;
    expect(catalog?.version).toBe(PROJECT_IDENTITY_CATALOG_VERSION);
    expect(catalog?.byTrailId.trl_word).toMatchObject({
      trailId: 'trl_word',
      currentPath: second,
      previousPaths: [first],
      configuredName: 'Word Sparkle Game',
      previousConfiguredNames: ['Word Sparkle'],
      currentFolderBasename: 'word_sparkle',
      previousFolderBasenames: ['word_sparkle_old'],
      entrypointBasenames: ['game.ts'],
      previousEntrypointBasenames: ['word_sparkle.py'],
      conflictPaths: [second, copied],
      editBacked: true,
    });
    expect(catalog?.byTrailId.trl_word?.editReferences).toHaveLength(2);

    noteKnownProject(second, 'trl_replacement');
    const replaced = readGlobalConfig().projectCatalog?.byTrailId;
    expect(replaced?.trl_word).toBeUndefined();
    expect(replaced?.trl_replacement).not.toHaveProperty('editReferences');
    expect(replaced?.trl_replacement).not.toHaveProperty('editBacked');
  });

  test('discards relative edit references', () => {
    const home = withTempHome();
    const project = join(home, 'projects', 'relative-reference');
    mkdirSync(project, { recursive: true });

    noteKnownProject(project, 'trl_relative_reference', {
      editReferences: [
        {
          ledgerId: 'led_relative',
          nativeSessionId: 'native_relative',
          segmentId: 'seg_relative',
          recordId: 'evt_relative',
          path: join('src', 'relative.ts'),
          basename: 'relative.ts',
        },
      ],
    });

    const identity = readGlobalConfig().projectCatalog?.byTrailId.trl_relative_reference;
    expect(identity).not.toHaveProperty('editReferences');
    expect(identity).not.toHaveProperty('editBacked');
  });

  test('replaces stale edit evidence without erasing path, name, or unrelated config', () => {
    const home = withTempHome();
    const first = join(home, 'projects', 'sparkle-old');
    const current = join(home, 'projects', 'sparkle-current');
    const conflict = join(home, 'projects', 'sparkle-copy');
    const other = join(home, 'projects', 'other');
    for (const path of [first, current, conflict, other]) {
      mkdirSync(path, { recursive: true });
    }

    noteKnownProject(first, 'trl_sanitize', {
      configuredName: 'Old Sparkle',
      entrypointBasenames: ['old_sparkle.py'],
      editReferences: [
        {
          ledgerId: 'led_old',
          nativeSessionId: 'native_old',
          segmentId: 'seg_old',
          recordId: 'evt_old',
          path: join(first, 'old_sparkle.py'),
          basename: 'old_sparkle.py',
        },
      ],
    });
    noteKnownProject(current, 'trl_sanitize', {
      configuredName: 'Current Sparkle',
      entrypointBasenames: ['poison_sparkle.py'],
      editReferences: [
        {
          ledgerId: 'led_poison',
          nativeSessionId: 'native_poison',
          segmentId: 'seg_poison',
          recordId: 'evt_poison',
          path: join(current, 'poison_sparkle.py'),
          basename: 'poison_sparkle.py',
        },
      ],
      conflictPaths: [current, conflict],
    });
    noteKnownProject(other, 'trl_other', { configuredName: 'Other Project' });
    writeGlobalConfig({
      ...readGlobalConfig(),
      autoInit: true,
      scratchPaths: [join(home, 'scratch')],
    });

    noteKnownProject(current, 'trl_sanitize', {
      configuredName: 'Current Sparkle',
      entrypointBasenames: [],
      editReferences: [],
      editBacked: false,
      replaceEditEvidence: true,
    });

    const config = readGlobalConfig();
    expect(config.autoInit).toBe(true);
    expect(config.scratchPaths).toEqual([join(home, 'scratch')]);
    expect(config.knownProjects?.find((item) => item.trailId === 'trl_sanitize')).toEqual(
      expect.objectContaining({
        trailId: 'trl_sanitize',
        path: current,
        previousPaths: [first],
      }),
    );
    expect(
      config.knownProjects?.find((item) => item.trailId === 'trl_sanitize'),
    ).not.toHaveProperty('editBacked');
    expect(config.projectCatalog?.byTrailId.trl_sanitize).toMatchObject({
      currentPath: current,
      previousPaths: [first],
      configuredName: 'Current Sparkle',
      previousConfiguredNames: ['Old Sparkle'],
      previousFolderBasenames: ['sparkle-old'],
      conflictPaths: [current, conflict],
    });
    expect(config.projectCatalog?.byTrailId.trl_sanitize).not.toHaveProperty(
      'entrypointBasenames',
    );
    expect(config.projectCatalog?.byTrailId.trl_sanitize).not.toHaveProperty(
      'previousEntrypointBasenames',
    );
    expect(config.projectCatalog?.byTrailId.trl_sanitize).not.toHaveProperty(
      'editReferences',
    );
    expect(config.projectCatalog?.byTrailId.trl_sanitize).not.toHaveProperty(
      'editBacked',
    );
    expect(config.projectCatalog?.byTrailId.trl_other).toMatchObject({
      currentPath: other,
      configuredName: 'Other Project',
    });
  });

  test('preserves an unsupported future identity catalog during observations', () => {
    const home = withTempHome();
    const project = join(home, 'projects', 'future-catalog');
    mkdirSync(project, { recursive: true });
    const futureCatalog = {
      version: 99,
      futureField: { retained: true },
      byTrailId: {
        trl_future: {
          trailId: 'trl_future',
          currentPath: project,
          currentFolderBasename: 'future-catalog',
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      },
    };
    writeGlobalConfig({
      version: 1,
      projectCatalog: futureCatalog as never,
    });

    noteKnownProject(project, 'trl_future', {
      entrypointBasenames: [],
      editReferences: [],
      replaceEditEvidence: true,
    });

    expect(readGlobalConfig().projectCatalog as unknown).toEqual(futureCatalog);
  });

  test('a corrupt file returns the default instead of throwing', () => {
    withTempHome();
    writeFileSync(globalConfigPath(), 'not json {', 'utf8');
    expect(() => readGlobalConfig()).not.toThrow();
    expect(readGlobalConfig()).toEqual({ version: 1 });
    expect(autoInitEnabled()).toBe(false);
  });

  test('SHOWTAIL_HOME overrides the location', () => {
    const home = withTempHome();
    expect(showtailHome()).toBe(home);
  });

  test('persists and clears explicit tool auto-connect opt-outs', () => {
    withTempHome();
    disableToolAutoConnect('codex');
    disableToolAutoConnect('codex');
    disableToolAutoConnect('antigravity-cli');
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual([
      'codex',
      'antigravity-cli',
    ]);

    enableToolAutoConnect('codex');
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual(['antigravity-cli']);
  });

  test('persists and clears global capture stops independently of auto-connect', () => {
    withTempHome();
    disableToolAutoConnect('gemini');
    disableToolCapture('codex');
    disableToolCapture('codex');
    disableToolCapture('claude');

    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
    expect(toolCaptureGloballyDisabled('gemini')).toBe(false);
    expect(readGlobalConfig().captureDisabledTools).toEqual(['codex', 'claude']);
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual(['gemini']);

    enableToolCapture('codex', '2026-09-09T12:00:00.000Z');

    expect(toolCaptureGloballyDisabled('codex')).toBe(false);
    expect(toolCaptureEnabledAt('codex')).toBe('2026-09-09T12:00:00.000Z');
    expect(toolCaptureGloballyDisabled('claude')).toBe(true);
    expect(readGlobalConfig().captureDisabledTools).toEqual(['claude']);
    expect(readGlobalConfig().autoConnectDisabledTools).toEqual(['gemini']);
  });

  test('per-tool consent survives stale and corrupt global config writes', () => {
    withTempHome();
    disableToolCapture('codex');

    expect(JSON.parse(readFileSync(toolCaptureConsentPath('codex'), 'utf8'))).toEqual({
      version: 1,
      tool: 'codex',
      capture: 'disabled',
    });

    // Simulate an unrelated full-config writer replacing the legacy mirror.
    writeGlobalConfig({ version: 1, autoInit: true });
    expect(toolCaptureGloballyDisabled('codex')).toBe(true);

    writeFileSync(globalConfigPath(), 'not json {', 'utf8');
    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
  });

  test('a corrupt per-tool consent marker fails closed', () => {
    withTempHome();
    disableToolCapture('codex');
    writeFileSync(toolCaptureConsentPath('codex'), 'not json {', 'utf8');
    writeGlobalConfig({ version: 1 });

    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
    expect(toolCaptureEnabledAt('codex')).toBeUndefined();
  });

  test('an invalid enabled timestamp fails closed', () => {
    withTempHome();
    disableToolCapture('codex');
    writeFileSync(
      toolCaptureConsentPath('codex'),
      JSON.stringify({
        version: 1,
        tool: 'codex',
        capture: 'enabled',
        enabledAt: 'not-a-timestamp',
      }),
      'utf8',
    );

    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
    expect(toolCaptureEnabledAt('codex')).toBeUndefined();
  });

  test('explicit enabled consent overrides a stale legacy stop', () => {
    withTempHome();
    disableToolCapture('codex');
    enableToolCapture('codex', '2026-09-09T12:00:00.000Z');

    // A stale global-config writer can reintroduce the old mirror, but not the stop.
    writeGlobalConfig({ version: 1, captureDisabledTools: ['codex'] });
    expect(JSON.parse(readFileSync(toolCaptureConsentPath('codex'), 'utf8'))).toEqual({
      version: 1,
      tool: 'codex',
      capture: 'enabled',
      enabledAt: '2026-09-09T12:00:00.000Z',
    });
    expect(toolCaptureGloballyDisabled('codex')).toBe(false);
  });

  test('repeated enables preserve the original resume boundary', () => {
    withTempHome();
    enableToolCapture('codex', '2026-09-09T12:00:00.000Z');
    enableToolCapture('codex', '2026-09-09T13:00:00.000Z');

    expect(toolCaptureEnabledAt('codex')).toBe('2026-09-09T12:00:00.000Z');
    expect(JSON.parse(readFileSync(toolCaptureConsentPath('codex'), 'utf8'))).toEqual({
      version: 1,
      tool: 'codex',
      capture: 'enabled',
      enabledAt: '2026-09-09T12:00:00.000Z',
    });
  });

  test('a timestamp-less enabled marker is accepted until the next explicit enable', () => {
    withTempHome();
    disableToolCapture('codex');
    writeFileSync(
      toolCaptureConsentPath('codex'),
      JSON.stringify({ version: 1, tool: 'codex', capture: 'enabled' }),
      'utf8',
    );

    expect(toolCaptureGloballyDisabled('codex')).toBe(false);
    expect(toolCaptureEnabledAt('codex')).toBeUndefined();

    enableToolCapture('codex', '2026-09-09T14:00:00.000Z');
    expect(toolCaptureEnabledAt('codex')).toBe('2026-09-09T14:00:00.000Z');
  });

  test('legacy capture stops remain authoritative when no per-tool state exists', () => {
    withTempHome();
    writeGlobalConfig({ version: 1, captureDisabledTools: ['codex'] });

    expect(toolCaptureGloballyDisabled('codex')).toBe(true);
  });

  test('an existing generation-1 install gets one pending generation-2 offer', () => {
    withTempHome();
    writeGlobalConfig({ version: 1, autoInit: true });
    const offer = detectHistoryUpgrade(2, '2026-08-30T12:00:00.000Z');
    expect(offer).toEqual({
      generation: 2,
      status: 'pending',
      detectedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(detectHistoryUpgrade(2)).toEqual(offer);
  });

  test('a machine with no prior global config is a fresh install, not an upgrade', () => {
    withTempHome();
    expect(detectHistoryUpgrade(2)).toBeUndefined();
    expect(readGlobalConfig()).toEqual({ version: 1 });
  });
});
