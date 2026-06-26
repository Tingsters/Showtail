import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    expect(result).toEqual([]);
    expect(f.calls()).toBe(0);
  });

  test('connects a detected, unconnected tool once and records it', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'copilot-cli', detected: true, connected: false });

    const result = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(result).toEqual([{ tool: 'copilot-cli', label: 'copilot-cli', hooks: true }]);
    expect(f.calls()).toBe(1);
    expect(handledTools(home)).toContain('copilot-cli');

    // Second sweep is a no-op — already handled.
    const again = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(again).toEqual([]);
    expect(f.calls()).toBe(1);
  });

  test('an already-connected tool is marked handled but never re-installed', () => {
    enableAutoInit(home);
    const f = fakePlugin({ cliName: 'claude', detected: true, connected: true });

    const result = autoConnectNewlyDetected('/repo', [f.plugin]);
    expect(result).toEqual([]); // already connected → nothing new
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

    expect(autoConnectNewlyDetected('/repo', [absent.plugin])).toEqual([]);
    expect(handledTools(home)).not.toContain('copilot-cli');

    // Now it's installed → the next sweep connects it.
    const present = fakePlugin({
      cliName: 'copilot-cli',
      detected: true,
      connected: false,
    });
    const result = autoConnectNewlyDetected('/repo', [present.plugin]);
    expect(result.map((r) => r.tool)).toEqual(['copilot-cli']);
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
    expect(result).toEqual([]);
    expect(afterDisconnect.calls()).toBe(0);
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
    expect(result).toEqual([]);
    // Not auto-connectable → never even recorded as handled.
    expect(handledTools(home)).not.toContain('antigravity-ide');
  });
});
