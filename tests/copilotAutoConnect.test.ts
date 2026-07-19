import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { copilotPlugin } from '../src/plugins/copilot.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function stubCli(dir: string, recordPath: string): string {
  const p = join(dir, 'code-stub.sh');
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${recordPath}"\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('copilot (VS Code) hands-off extension install', () => {
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

  test('is never pre-seeded before install (prewireSafe is false)', () => {
    expect(copilotPlugin.connect?.prewireSafe).toBe(false);
  });

  test('detect() is true when a VS Code CLI is locatable', () => {
    const dir = makeTempDir();
    try {
      const cli = join(dir, 'code');
      writeFileSync(cli, '');
      process.env.SHOWTAIL_VSCODE_CLI = cli;
      expect(copilotPlugin.connect?.detect()).toBe(true);

      process.env.SHOWTAIL_VSCODE_CLI = join(dir, 'nope');
      expect(copilotPlugin.connect?.detect()).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('autoConnect installs the extension via the VS Code CLI, hands-off', () => {
    const dir = makeTempDir();
    try {
      const record = join(dir, 'args.txt');
      const vsix = join(dir, 'showtail.vsix');
      writeFileSync(vsix, 'fake');
      process.env.SHOWTAIL_VSCODE_CLI = stubCli(dir, record);
      process.env.SHOWTAIL_VSIX = vsix;

      const result = copilotPlugin.connect?.autoConnect?.();
      expect(result).toEqual({ hooks: false });
      const args = readFileSync(record, 'utf8');
      expect(args).toContain('--install-extension');
      expect(args).toContain(vsix);
    } finally {
      cleanup(dir);
    }
  });
});
