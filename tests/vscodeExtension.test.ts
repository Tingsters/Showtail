import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  findVsCodeCli,
  installVsCodeExtension,
  VSCODE_EXTENSION_ID,
} from '../src/core/vscodeExtension.ts';
import { cleanup, makeTempDir, stubCli, stubCliScript } from './helpers.ts';

// `stubCli` stands in for the `code` CLI: a `#!/bin/sh` script on POSIX, a `.cmd`
// batch file on Windows (where CreateProcess can't launch a `.sh` and chmod is a
// no-op). Both record one dequoted argument per line, so the assertions below are
// platform-neutral and these tests run on every leg of the matrix.

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

  test('installs the bundled VSIX hands-off via `<cli> --install-extension <vsix> --force`', () => {
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
  });

  test('falls back to the Marketplace id when no VSIX is bundled', () => {
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
  });
});

/**
 * The tests above execute the stub, so on any one machine only that machine's
 * branch of `stubCliScript` is ever run. These assert the *other* branch's text
 * from wherever the suite happens to be — much weaker than running it, but it
 * pins the two properties an install test silently depends on: a launchable
 * extension, and one dequoted argument per line (`%~1` + `shift`, never `%*`,
 * whose raw quoted tail would make `toContain` diverge from the sh branch).
 */
describe('stubCli script shape (both platforms, asserted everywhere)', () => {
  const record = join('C:\\tmp\\showtail-test', 'args.txt');

  test('the windows branch is a launchable batch file that dequotes per line', () => {
    const { ext, body, mode } = stubCliScript(record, 'win32');
    expect(ext).toBe('.cmd'); // CreateProcess will not launch a .sh
    expect(mode).toBeNull(); // chmod is a no-op on Windows
    expect(body).toContain('@echo off');
    expect(body).toContain(record);
    expect(body).toContain('echo(%~1'); // dequoted, one arg per line
    expect(body).toContain('shift');
    expect(body).not.toContain('%*'); // raw quoted tail — would break toContain
    expect(body).toContain('exit /b 0');
    expect(body.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });

  test('the posix branch stays a chmod-ed shell script', () => {
    const { ext, body, mode } = stubCliScript(record, 'darwin');
    expect(ext).toBe('.sh');
    expect(mode).toBe(0o755);
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body).toContain(`printf '%s\\n' "$@" > "${record}"`);
  });

  test('the written stub carries the platform extension, so callers must use the return', () => {
    const dir = makeTempDir();
    try {
      const p = stubCli(dir, join(dir, 'args.txt'));
      expect(p.endsWith(process.platform === 'win32' ? '.cmd' : '.sh')).toBe(true);
      expect(readFileSync(p, 'utf8')).toBe(stubCliScript(join(dir, 'args.txt')).body);
    } finally {
      cleanup(dir);
    }
  });
});
