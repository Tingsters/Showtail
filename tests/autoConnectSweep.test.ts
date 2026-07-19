import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoConnectNewlyDetected } from '../src/core/autoConnectSweep.ts';
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
}): { plugin: ConnectPlugin; calls: () => number } {
  let calls = 0;
  const plugin = {
    id: opts.cliName,
    cliName: opts.cliName,
    label: opts.cliName,
    aliases: [],
    connect: {
      detect: () => opts.detected,
      status: () => ({ connected: opts.connected }),
      prewireSafe: opts.prewireSafe ?? false,
      autoConnect:
        opts.hasAutoConnect === false
          ? undefined
          : () => {
              calls++;
              return { hooks: opts.hooks ?? true };
            },
    },
  } as unknown as ConnectPlugin;
  return { plugin, calls: () => calls };
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

  test('a Showtail version bump refreshes an already-wired tool once, and reports it', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: false });

    autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(f.calls()).toBe(1); // first wire

    // Pretend the hooks were written by an older Showtail.
    const cfgPath = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.wiringVersion = '0.0.0';
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

  test('records the wiring version so the refresh check is stable', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: false });
    autoConnectNewlyDetected('/repo', [f.plugin]);
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(typeof cfg.wiringVersion).toBe('string');
    expect(cfg.wiringVersion.length).toBeGreaterThan(0);
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
