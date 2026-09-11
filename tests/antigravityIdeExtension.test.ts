import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  antigravityIdeExtensionInstalled,
  antigravityExtensionListContainsShowtail,
  bundledVsixPath,
  findAntigravityIdeCli,
  installAntigravityIdeExtension,
  uninstallAntigravityIdeExtension,
} from '../src/core/antigravityIdeExtension.ts';
import { antigravityIdePlugin } from '../src/plugins/antigravity-ide.ts';
import { cleanup, makeTempDir, stubCli, stubInstalledExtensionCli } from './helpers.ts';

describe('antigravity-ide extension install (env-overridable, no real IDE)', () => {
  const saved = {
    cli: process.env.SHOWTAIL_ANTIGRAVITY_CLI,
    vsix: process.env.SHOWTAIL_VSIX,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      const key = k === 'cli' ? 'SHOWTAIL_ANTIGRAVITY_CLI' : 'SHOWTAIL_VSIX';
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  test('overrides locate the CLI and the bundled VSIX when present', () => {
    const dir = makeTempDir();
    try {
      const cli = join(dir, 'antigravity-ide.cmd');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(cli, '');
      writeFileSync(vsix, '');
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = cli;
      process.env.SHOWTAIL_VSIX = vsix;
      expect(findAntigravityIdeCli()).toBe(cli);
      expect(bundledVsixPath()).toBe(vsix);
    } finally {
      cleanup(dir);
    }
  });

  test('recognizes Showtail in native extension-list output', () => {
    expect(
      antigravityExtensionListContainsShowtail(
        'publisher.other\r\ntingsters.showtail\r\n',
      ),
    ).toBe(true);
    expect(antigravityExtensionListContainsShowtail('publisher.other\n')).toBe(false);
  });

  test('extension-backed capture is reported as connected and active', () => {
    const dir = makeTempDir();
    try {
      const cli = join(
        dir,
        process.platform === 'win32' ? 'antigravity-ide.cmd' : 'antigravity-ide.sh',
      );
      const body =
        process.platform === 'win32'
          ? '@echo off\r\nif "%~1"=="--list-extensions" echo Tingsters.Showtail\r\nexit /b 0\r\n'
          : '#!/bin/sh\n[ "$1" = "--list-extensions" ] && printf "Tingsters.Showtail\\n"\n';
      writeFileSync(cli, body);
      if (process.platform !== 'win32') chmodSync(cli, 0o755);
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = cli;

      expect(antigravityIdeExtensionInstalled()).toBe(true);
      expect(antigravityIdePlugin.connect!.status(dir)).toMatchObject({
        connected: true,
        hooksActive: false,
        captureActive: true,
      });
    } finally {
      cleanup(dir);
    }
  });

  test('reports cli-not-found when the IDE CLI override points nowhere', () => {
    const dir = makeTempDir();
    try {
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = join(dir, 'nope.cmd');
      const res = installAntigravityIdeExtension();
      expect(res.installed).toBe(false);
      expect(res.reason).toBe('cli-not-found');
    } finally {
      cleanup(dir);
    }
  });

  test('reports vsix-not-bundled when the CLI exists but no VSIX is shipped', () => {
    const dir = makeTempDir();
    try {
      const cli = join(dir, 'antigravity-ide.cmd');
      writeFileSync(cli, '');
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = cli;
      process.env.SHOWTAIL_VSIX = join(dir, 'absent.vsix');
      const res = installAntigravityIdeExtension();
      expect(res.installed).toBe(false);
      expect(res.cli).toBe(cli);
      expect(res.reason).toBe('vsix-not-bundled');
    } finally {
      cleanup(dir);
    }
  });

  // `stubCli` writes a `.cmd` batch file on Windows and a chmod-ed `#!/bin/sh`
  // script elsewhere — the IDE CLI it stands in for is itself `antigravity-ide.cmd`
  // on Windows — so this runs on every leg. Take the path from the return value: the
  // extension differs per platform.
  test('installs hands-off when both the IDE CLI and the bundled VSIX are present', () => {
    const dir = makeTempDir();
    try {
      const record = join(dir, 'args.txt');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(vsix, 'fake');
      const cli = stubCli(dir, record, 'antigravity-ide');
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = cli;
      process.env.SHOWTAIL_VSIX = vsix;

      const res = installAntigravityIdeExtension();
      expect(res.installed).toBe(true); // §3 vsix availability makes it hands-off
      const args = readFileSync(record, 'utf8');
      expect(args).toContain('--install-extension');
      expect(args).toContain(vsix);
    } finally {
      cleanup(dir);
    }
  });

  test('uninstalls the native capture extension through the IDE CLI', () => {
    const dir = makeTempDir();
    try {
      const record = join(dir, 'args.txt');
      process.env.SHOWTAIL_ANTIGRAVITY_CLI = stubInstalledExtensionCli(
        dir,
        record,
        'tingsters.showtail',
        'antigravity-ide',
      );

      const result = uninstallAntigravityIdeExtension();

      expect(result).toMatchObject({ uninstalled: true, wasInstalled: true });
      const args = readFileSync(record, 'utf8');
      expect(args).toContain('--uninstall-extension');
      expect(args).toContain('tingsters.showtail');
    } finally {
      cleanup(dir);
    }
  });
});
