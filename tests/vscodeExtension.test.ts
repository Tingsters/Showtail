import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  findVsCodeCli,
  installVsCodeExtension,
  VSCODE_EXTENSION_ID,
} from '../src/core/vscodeExtension.ts';
import { cleanup, makeTempDir } from './helpers.ts';

// The stub CLI below is a `#!/bin/sh` script made executable with chmod. Neither
// half of that works on Windows: the shebang is ignored, `chmod` is a no-op, and
// CreateProcess refuses to launch a `.sh` file, so `spawnSync(cli, …)` in
// installVsCodeExtension() fails with ENOENT/EACCES before the assertion runs.
// Only the tests that actually *spawn* the stub are gated; detection tests still
// run everywhere. Windows extension install is covered manually for now.
const skipOnWindows = process.platform === 'win32';

/** Write an executable stub `code` CLI that records its argv to `recordPath` and exits 0. */
function stubCli(dir: string, recordPath: string): string {
  const p = join(dir, 'code-stub.sh');
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${recordPath}"\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('vscode extension install (env-overridable, no real VS Code)', () => {
  const saved = {
    cli: process.env.SHOWTAIL_VSCODE_CLI,
    vsix: process.env.SHOWTAIL_VSIX,
  };
  afterEach(() => {
    for (const [k, key] of [
      ['cli', 'SHOWTAIL_VSCODE_CLI'],
      ['vsix', 'SHOWTAIL_VSIX'],
    ] as const) {
      const v = saved[k];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  test('findVsCodeCli honors the override and reports cli-not-found when absent', () => {
    const dir = makeTempDir();
    try {
      const cli = join(dir, 'code');
      writeFileSync(cli, '');
      process.env.SHOWTAIL_VSCODE_CLI = cli;
      expect(findVsCodeCli()).toBe(cli);

      process.env.SHOWTAIL_VSCODE_CLI = join(dir, 'nope');
      expect(findVsCodeCli()).toBeNull();
      const res = installVsCodeExtension();
      expect(res.installed).toBe(false);
      expect(res.reason).toBe('cli-not-found');
    } finally {
      cleanup(dir);
    }
  });

  test.skipIf(skipOnWindows)(
    'installs the bundled VSIX hands-off via `<cli> --install-extension <vsix> --force`',
    () => {
      const dir = makeTempDir();
      try {
        const record = join(dir, 'args.txt');
        const vsix = join(dir, 'showtail.vsix');
        writeFileSync(vsix, 'fake-vsix');
        process.env.SHOWTAIL_VSCODE_CLI = stubCli(dir, record);
        process.env.SHOWTAIL_VSIX = vsix;

        const res = installVsCodeExtension();
        expect(res.installed).toBe(true);
        const args = readFileSync(record, 'utf8');
        expect(args).toContain('--install-extension');
        expect(args).toContain(vsix); // the bundled vsix, not the marketplace id
        expect(args).toContain('--force');
      } finally {
        cleanup(dir);
      }
    },
  );

  test.skipIf(skipOnWindows)(
    'falls back to the Marketplace id when no VSIX is bundled',
    () => {
      const dir = makeTempDir();
      try {
        const record = join(dir, 'args.txt');
        process.env.SHOWTAIL_VSCODE_CLI = stubCli(dir, record);
        process.env.SHOWTAIL_VSIX = join(dir, 'absent.vsix'); // bundledVsixPath → null

        const res = installVsCodeExtension();
        expect(res.installed).toBe(true);
        expect(readFileSync(record, 'utf8')).toContain(VSCODE_EXTENSION_ID);
      } finally {
        cleanup(dir);
      }
    },
  );
});
