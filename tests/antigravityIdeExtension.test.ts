import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  bundledVsixPath,
  findAntigravityIdeCli,
  installAntigravityIdeExtension,
} from '../src/core/antigravityIdeExtension.ts';
import { cleanup, makeTempDir } from './helpers.ts';

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

  // The stub CLI here is a `#!/bin/sh` script made executable with chmod. Neither
  // half works on Windows: the shebang is ignored, `chmod` is a no-op, and
  // CreateProcess refuses to launch a `.sh` file, so the spawnSync inside
  // installAntigravityIdeExtension() fails with ENOENT/EACCES before the assertion
  // runs. The sibling `.cmd` detection tests above are platform-neutral and still run.
  test.skipIf(process.platform === 'win32')(
    'installs hands-off when both the IDE CLI and the bundled VSIX are present',
    () => {
      const dir = makeTempDir();
      try {
        const record = join(dir, 'args.txt');
        const cli = join(dir, 'antigravity-ide.sh');
        const vsix = join(dir, 'showtail.vsix');
        writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit 0\n`);
        chmodSync(cli, 0o755);
        writeFileSync(vsix, 'fake');
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
    },
  );
});
