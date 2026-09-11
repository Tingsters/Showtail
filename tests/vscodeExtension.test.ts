import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  findVsCodeCli,
  installVsCodeExtension,
  uninstallVsCodeExtension,
  VSCODE_EXTENSION_ID,
  vscodeExtensionInstalled,
  vscodeExtensionListContainsShowtail,
} from '../src/core/vscodeExtension.ts';
import { extensionCliInvocation } from '../src/core/extensionCli.ts';
import {
  cleanup,
  makeTempDir,
  stubCli,
  stubCliScript,
  stubInstalledExtensionCli,
} from './helpers.ts';
import { copilotPlugin } from '../src/plugins/copilot.ts';
import {
  isVsCodeExtensionPayload,
  VSCODE_EXTENSION_HOOK_PROTOCOL,
  vscodeExtensionTranscript,
} from '../src/core/vscodeExtensionHook.ts';

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
      expect(copilotPlugin.connect!.autoConnect!()).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  test('detects the installed extension and reports native capture as active', () => {
    const dir = makeTempDir();
    try {
      const cli = join(dir, process.platform === 'win32' ? 'code.cmd' : 'code.sh');
      const body =
        process.platform === 'win32'
          ? '@echo off\r\nif "%~1"=="--list-extensions" echo Tingsters.Showtail\r\nexit /b 0\r\n'
          : '#!/bin/sh\n[ "$1" = "--list-extensions" ] && printf "Tingsters.Showtail\\n"\n';
      writeFileSync(cli, body);
      if (process.platform !== 'win32') chmodSync(cli, 0o755);
      process.env.SHOWTAIL_VSCODE_CLI = cli;

      expect(
        vscodeExtensionListContainsShowtail('publisher.other\r\ntingsters.showtail\r\n'),
      ).toBe(true);
      expect(vscodeExtensionInstalled()).toBe(true);
      expect(copilotPlugin.connect!.status(dir)).toMatchObject({
        connected: true,
        captureActive: true,
      });
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

  test('uninstalls the native capture extension through the VS Code CLI', () => {
    const dir = makeTempDir();
    try {
      const record = join(dir, 'args.txt');
      process.env.SHOWTAIL_VSCODE_CLI = stubInstalledExtensionCli(
        dir,
        record,
        VSCODE_EXTENSION_ID,
        'code',
      );

      const result = uninstallVsCodeExtension();

      expect(result).toMatchObject({ uninstalled: true, wasInstalled: true });
      const args = readFileSync(record, 'utf8');
      expect(args).toContain('--uninstall-extension');
      expect(args).toContain(VSCODE_EXTENSION_ID);
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

describe('extension CLI process invocation', () => {
  const args = ['--install-extension', 'C:\\tmp\\Showtail Extension.vsix', '--force'];

  test('routes every Windows launcher through cmd.exe', () => {
    const commandProcessor = 'C:\\Windows\\System32\\cmd.exe';
    for (const cli of ['code', 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd']) {
      expect(extensionCliInvocation(cli, args, 'win32', commandProcessor)).toEqual({
        command: commandProcessor,
        args: ['/d', '/c', cli, ...args],
      });
    }
  });

  test('executes POSIX launchers directly', () => {
    expect(extensionCliInvocation('/usr/bin/code', args, 'linux')).toEqual({
      command: '/usr/bin/code',
      args,
    });
  });
});

describe('VS Code extension hook payload', () => {
  test('requires and propagates the extension event timestamp', () => {
    const dir = makeTempDir();
    try {
      const timestamp = '2026-09-09T12:34:56.000Z';
      const payload = {
        showtailExtension: VSCODE_EXTENSION_HOOK_PROTOCOL,
        session_id: 'extension-session',
        cwd: dir,
        projectCwd: dir,
        workspacePaths: [dir],
        timestamp,
        assistant: {
          text: 'The response completed after capture resumed.',
          sourceId: 'assistant-response-1',
          model: 'copilot-test',
        },
      };

      expect(isVsCodeExtensionPayload(payload)).toBe(true);
      expect(vscodeExtensionTranscript(payload)?.messages[0]).toMatchObject({
        role: 'assistant',
        timestamp,
      });
      expect(isVsCodeExtensionPayload({ ...payload, timestamp: undefined })).toBe(false);
      expect(isVsCodeExtensionPayload({ ...payload, timestamp: 'invalid' })).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});
