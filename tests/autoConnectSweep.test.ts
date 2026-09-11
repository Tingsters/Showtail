import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoConnectNewlyDetected } from '../src/core/autoConnectSweep.ts';
import { disableToolCapture } from '../src/core/globalConfig.ts';
import { MANAGED_INSTRUCTION_REVISION, SHOWTAIL_VERSION } from '../src/core/version.ts';
import type { ConnectPlugin } from '../src/plugins/registry.ts';
import { cleanup, enableAutoInit, makeTempDir } from './helpers.ts';

/** A controllable fake connect plugin; records how often autoConnect ran. */
function fakePlugin(opts: {
  cliName: string;
  detected: boolean;
  connected: boolean;
  hooks?: boolean;
  hasAutoConnect?: boolean;
  prewireSafe?: boolean;
  autoConnectAvailable?: boolean;
  autoConnectError?: string;
}): {
  plugin: ConnectPlugin;
  calls: () => number;
  setDetected: (value: boolean) => void;
  setAutoConnectAvailable: (value: boolean) => void;
} {
  let calls = 0;
  let detected = opts.detected;
  let autoConnectAvailable = opts.autoConnectAvailable ?? true;
  const plugin = {
    id: opts.cliName,
    cliName: opts.cliName,
    label: opts.cliName,
    aliases: [],
    connect: {
      detect: () => detected,
      status: () => ({ connected: opts.connected }),
      prewireSafe: opts.prewireSafe ?? false,
      autoConnect:
        opts.hasAutoConnect === false
          ? undefined
          : () => {
              calls++;
              if (opts.autoConnectError) throw new Error(opts.autoConnectError);
              return autoConnectAvailable ? { hooks: opts.hooks ?? true } : null;
            },
    },
  } as unknown as ConnectPlugin;
  return {
    plugin,
    calls: () => calls,
    setDetected: (value: boolean) => {
      detected = value;
    },
    setAutoConnectAvailable: (value: boolean) => {
      autoConnectAvailable = value;
    },
  };
}

function handledTools(home: string): string[] {
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  return cfg.autoConnectedTools ?? [];
}

describe('autoConnectNewlyDetected sweep', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = makeTempDir();
    prevHome = process.env.SHOWTAIL_HOME;
    process.env.SHOWTAIL_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = prevHome;
    cleanup(home);
  });

  test('does nothing until the user has opted in via setup', () => {
    // No enableAutoInit → autoInit is off.
    const f = fakePlugin({ cliName: 'copilot-cli', detected: true, connected: false });
    const result = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(result.connected).toEqual([]);
    expect(f.calls()).toBe(0);
  });

  test('connects a detected, unconnected tool once and records it', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'copilot-cli', detected: true, connected: false });

    const result = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(result.connected).toEqual([
      { tool: 'copilot-cli', label: 'copilot-cli', hooks: true },
    ]);
    expect(f.calls()).toBe(1);
    expect(handledTools(home)).toContain('copilot-cli');

    // Second sweep is a no-op — already handled.
    const again = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(again.connected).toEqual([]);
    expect(f.calls()).toBe(1);
  });

  test('an already-connected tool is marked handled but never re-installed', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: true });

    const result = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(result.connected).toEqual([]); // already connected → nothing new
    expect(f.calls()).toBe(0); // never rewrites an already-connected tool
    expect(handledTools(home)).toContain('claude'); // but recorded as handled
  });

  test('a not-yet-installed tool stays unhandled and is reconsidered later', () => {
    enableAutoInit(home);
    const absent = fakePlugin({
      cliName: 'copilot-cli',
      detected: false,
      connected: false,
    });

    expect(autoConnectNewlyDetected('/repo', [absent.plugin]).connected).toEqual([]);
    expect(handledTools(home)).not.toContain('copilot-cli');

    // Now it's installed → the next sweep connects it.
    const present = fakePlugin({
      cliName: 'copilot-cli',
      detected: true,
      connected: false,
    });
    const result = autoConnectNewlyDetected('/repo', [present.plugin]);
    expect(result.connected.map((r) => r.tool)).toEqual(['copilot-cli']);
    expect(present.calls()).toBe(1);
  });

  test('does not re-connect a tool the user disconnected after it was handled', () => {
    enableAutoInit(home);
    // First: connect it.
    const connectedRun = fakePlugin({
      cliName: 'copilot-cli',
      detected: true,
      connected: false,
    });
    autoConnectNewlyDetected('/repo', [connectedRun.plugin]);
    expect(connectedRun.calls()).toBe(1);

    // User runs `disconnect`: it's detected but no longer connected. The sweep
    // must NOT fight them — it's already in the handled set.
    const afterDisconnect = fakePlugin({
      cliName: 'copilot-cli',
      detected: true,
      connected: false,
    });
    const result = autoConnectNewlyDetected('/repo', [afterDisconnect.plugin]);
    expect(result.connected).toEqual([]);
    expect(afterDisconnect.calls()).toBe(0);
  });

  test('an explicit disconnect remains disabled across later generation bumps', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'codex', detected: true, connected: false });
    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1);

    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.managedInstructionRevision = MANAGED_INSTRUCTION_REVISION - 1;
    cfg.toolIntegrationGenerations.codex = `${SHOWTAIL_VERSION}:${MANAGED_INSTRUCTION_REVISION - 1}`;
    cfg.autoConnectDisabledTools = ['codex'];
    writeFileSync(cfgPath, JSON.stringify(cfg));

    autoConnectNewlyDetected('/repo', [f.plugin]);
    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1);

    const enabled = JSON.parse(readFileSync(cfgPath, 'utf8'));
    enabled.autoConnectDisabledTools = [];
    writeFileSync(cfgPath, JSON.stringify(enabled));

    expect(autoConnectNewlyDetected('/repo', [f.plugin]).refreshed).toEqual(['codex']);
    expect(f.calls()).toBe(2);
  });

  test('a machine-wide capture stop excludes a tool from connect and refresh sweeps', () => {
    enableAutoInit(home);
    disableToolCapture('codex');
    const f = fakePlugin({ cliName: 'codex', detected: true, connected: false });

    expect(autoConnectNewlyDetected('/repo', [f.plugin], { connectAll: true })).toEqual({
      connected: [],
      refreshed: [],
      pending: [],
      failed: [],
    });
    expect(f.calls()).toBe(0);
    expect(handledTools(home)).not.toContain('codex');
  });

  test('rechecks capture consent after detection before installing', () => {
    enableAutoInit(home);
    let calls = 0;
    const plugin = {
      id: 'codex',
      cliName: 'codex',
      label: 'codex',
      aliases: [],
      connect: {
        detect: () => {
          disableToolCapture('codex');
          return true;
        },
        status: () => ({ connected: false }),
        autoConnect: () => {
          calls += 1;
          return { hooks: true };
        },
      },
    } as unknown as ConnectPlugin;

    expect(autoConnectNewlyDetected('/repo', [plugin], { connectAll: true })).toEqual({
      connected: [],
      refreshed: [],
      pending: [],
      failed: [],
    });
    expect(calls).toBe(0);
    expect(handledTools(home)).not.toContain('codex');
  });

  test('connectAll pre-wires an UNinstalled tool ONLY when prewireSafe', () => {
    enableAutoInit(home);
    const safe = fakePlugin({
      cliName: 'claude',
      detected: false,
      connected: false,
      prewireSafe: true,
    });
    const result = autoConnectNewlyDetected('/repo', [safe.plugin], { connectAll: true });
    expect(result.connected.map((r) => r.tool)).toEqual(['claude']);
    expect(safe.calls()).toBe(1);
    expect(handledTools(home)).toContain('claude');
  });

  test('connectAll does NOT pre-wire an UNinstalled, non-prewireSafe tool — it waits for detection', () => {
    enableAutoInit(home);
    const unsafe = fakePlugin({
      cliName: 'codex',
      detected: false,
      connected: false,
      prewireSafe: false,
    });
    // Undetected + not prewireSafe → not touched, not marked handled.
    const first = autoConnectNewlyDetected('/repo', [unsafe.plugin], {
      connectAll: true,
    });
    expect(first.connected).toEqual([]);
    expect(unsafe.calls()).toBe(0);
    expect(handledTools(home)).not.toContain('codex');

    // Once it's actually installed, the sweep connects it (post-install, no pre-seed).
    const installed = fakePlugin({
      cliName: 'codex',
      detected: true,
      connected: false,
      prewireSafe: false,
    });
    const second = autoConnectNewlyDetected('/repo', [installed.plugin], {
      connectAll: true,
    });
    expect(second.connected.map((r) => r.tool)).toEqual(['codex']);
    expect(installed.calls()).toBe(1);
  });

  test('an incomplete auto-connect stays stale and retries until it succeeds', () => {
    enableAutoInit(home);
    const cfgPath = join(home, 'config.json');
    const legacy = JSON.parse(readFileSync(cfgPath, 'utf8'));
    legacy.wiringVersion = SHOWTAIL_VERSION;
    legacy.managedInstructionRevision = MANAGED_INSTRUCTION_REVISION;
    writeFileSync(cfgPath, JSON.stringify(legacy));

    const f = fakePlugin({
      cliName: 'copilot',
      detected: true,
      connected: false,
      autoConnectAvailable: false,
    });

    const first = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(first.connected).toEqual([]);
    expect(first.pending).toEqual([
      {
        tool: 'copilot',
        label: 'copilot',
        operation: 'connect',
        state: 'pending',
      },
    ]);
    expect(f.calls()).toBe(1);

    const pending = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(pending.autoConnectedTools).toContain('copilot');
    expect(pending.toolIntegrationGenerations.copilot).toBeUndefined();

    const retry = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(retry.refreshed).toEqual([]);
    expect(retry.pending[0]).toMatchObject({
      tool: 'copilot',
      operation: 'refresh',
      state: 'pending',
    });
    expect(f.calls()).toBe(2);

    f.setAutoConnectAvailable(true);
    expect(autoConnectNewlyDetected('/repo', [f.plugin]).refreshed).toEqual(['copilot']);
    expect(f.calls()).toBe(3);

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(3);
  });

  test('a thrown connect failure is surfaced and remains stale for retry', () => {
    enableAutoInit(home);
    const f = fakePlugin({
      cliName: 'codex',
      detected: true,
      connected: false,
      autoConnectError: 'permission denied',
    });

    const first = autoConnectNewlyDetected('/repo', [f.plugin]);

    expect(first.failed).toEqual([
      {
        tool: 'codex',
        label: 'codex',
        operation: 'connect',
        state: 'failed',
        reason: 'permission denied',
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
        .toolIntegrationGenerations.codex,
    ).toBeUndefined();

    const retry = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(retry.failed[0]).toMatchObject({
      tool: 'codex',
      operation: 'refresh',
      state: 'failed',
    });
    expect(f.calls()).toBe(2);
  });

  test('a Showtail version bump refreshes an already-wired tool once, and reports it', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: false });

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1); // first wire

    // Pretend the hooks were written by an older Showtail.
    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.wiringVersion = '0.0.0';
    delete cfg.toolIntegrationGenerations;
    writeFileSync(cfgPath, JSON.stringify(cfg));

    // The next sweep re-runs autoConnect once to refresh the hook format, and reports it.
    const refreshedRun = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(2);
    expect(refreshedRun.refreshed).toEqual(['claude']);

    // ...and once the wiring is current again, further sweeps are no-ops.
    const stable = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(2);
    expect(stable.refreshed).toEqual([]);
  });

  test('a managed-instruction revision bump refreshes without a semver change', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'codex', detected: true, connected: false });

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1);

    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.wiringVersion = SHOWTAIL_VERSION;
    cfg.managedInstructionRevision = MANAGED_INSTRUCTION_REVISION - 1;
    delete cfg.toolIntegrationGenerations;
    writeFileSync(cfgPath, JSON.stringify(cfg));

    const refreshedRun = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(2);
    expect(refreshedRun.refreshed).toEqual(['codex']);

    const refreshedConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(refreshedConfig.wiringVersion).toBe(SHOWTAIL_VERSION);
    expect(refreshedConfig.managedInstructionRevision).toBe(MANAGED_INSTRUCTION_REVISION);

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(2);
  });

  test('current per-tool state repairs stale legacy stamps without refreshing again', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'codex', detected: true, connected: false });

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1);

    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.wiringVersion = '0.0.0';
    writeFileSync(cfgPath, JSON.stringify(cfg));

    const repaired = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(repaired.refreshed).toEqual([]);
    expect(f.calls()).toBe(1);
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).wiringVersion).toBe(
      SHOWTAIL_VERSION,
    );
  });

  test('a temporarily undetected handled tool catches up without re-refreshing current tools', () => {
    enableAutoInit(home);
    const present = fakePlugin({ cliName: 'codex', detected: true, connected: false });
    const missing = fakePlugin({
      cliName: 'antigravity-cli',
      detected: true,
      connected: false,
      prewireSafe: false,
    });
    const options = { connectAll: true };

    autoConnectNewlyDetected('/repo', [present.plugin, missing.plugin], options);
    expect(present.calls()).toBe(1);
    expect(missing.calls()).toBe(1);

    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const staleGeneration = `${SHOWTAIL_VERSION}:${MANAGED_INSTRUCTION_REVISION - 1}`;
    cfg.managedInstructionRevision = MANAGED_INSTRUCTION_REVISION - 1;
    cfg.toolIntegrationGenerations = {
      codex: staleGeneration,
      'antigravity-cli': staleGeneration,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg));

    missing.setDetected(false);
    const firstRefresh = autoConnectNewlyDetected(
      '/repo',
      [present.plugin, missing.plugin],
      options,
    );
    expect(firstRefresh.refreshed).toEqual(['codex']);
    expect(present.calls()).toBe(2);
    expect(missing.calls()).toBe(1);

    const partiallyRefreshed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(partiallyRefreshed.managedInstructionRevision).toBe(
      MANAGED_INSTRUCTION_REVISION - 1,
    );
    expect(partiallyRefreshed.toolIntegrationGenerations.codex).toBe(
      `${SHOWTAIL_VERSION}:${MANAGED_INSTRUCTION_REVISION}`,
    );
    expect(partiallyRefreshed.toolIntegrationGenerations['antigravity-cli']).toBe(
      staleGeneration,
    );

    const stillMissing = autoConnectNewlyDetected(
      '/repo',
      [present.plugin, missing.plugin],
      options,
    );
    expect(stillMissing.refreshed).toEqual([]);
    expect(present.calls()).toBe(2);
    expect(missing.calls()).toBe(1);

    missing.setDetected(true);
    const returned = autoConnectNewlyDetected(
      '/repo',
      [present.plugin, missing.plugin],
      options,
    );
    expect(returned.refreshed).toEqual(['antigravity-cli']);
    expect(present.calls()).toBe(2);
    expect(missing.calls()).toBe(2);

    const current = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(current.managedInstructionRevision).toBe(MANAGED_INSTRUCTION_REVISION);

    const stable = autoConnectNewlyDetected(
      '/repo',
      [present.plugin, missing.plugin],
      options,
    );
    expect(stable.refreshed).toEqual([]);
    expect(present.calls()).toBe(2);
    expect(missing.calls()).toBe(2);
  });

  test('records the wiring version and instruction revision so refresh is stable', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: false });
    autoConnectNewlyDetected('/repo', [f.plugin]);
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(typeof cfg.wiringVersion).toBe('string');
    expect(cfg.wiringVersion.length).toBeGreaterThan(0);
    expect(cfg.managedInstructionRevision).toBe(MANAGED_INSTRUCTION_REVISION);
    expect(cfg.toolIntegrationGenerations.claude).toBe(
      `${SHOWTAIL_VERSION}:${MANAGED_INSTRUCTION_REVISION}`,
    );
  });

  test('skips plugins without an autoConnect (manual-only, e.g. an IDE extension)', () => {
    enableAutoInit(home);
    const manual = fakePlugin({
      cliName: 'antigravity-ide',
      detected: true,
      connected: false,
      hasAutoConnect: false,
    });
    const result = autoConnectNewlyDetected('/repo', [manual.plugin]);
    expect(result.connected).toEqual([]);
    // Not auto-connectable → never even recorded as handled.
    expect(handledTools(home)).not.toContain('antigravity-ide');
  });
});
