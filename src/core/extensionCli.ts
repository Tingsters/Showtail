import { spawnSync } from 'node:child_process';

export interface ExtensionCliInvocation {
  command: string;
  args: string[];
}

/**
 * Build the process invocation for a VS Code-compatible extension launcher.
 *
 * Windows installs expose `code`-style CLIs as `.cmd` files. CreateProcess (and
 * therefore a direct `spawnSync`) cannot execute batch files, including a bare
 * `code` command that PATHEXT resolves to `code.cmd`; route every Windows launch
 * through the command processor instead. Passing each token as a spawn argument
 * leaves Node/Bun responsible for Windows command-line quoting, including paths
 * under `Program Files` and temporary directories containing spaces.
 */
export function extensionCliInvocation(
  cli: string,
  args: string[],
  targetPlatform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): ExtensionCliInvocation {
  if (targetPlatform === 'win32') {
    return { command: commandProcessor, args: ['/d', '/c', cli, ...args] };
  }
  return { command: cli, args };
}

/** Run an extension launcher and capture its human-readable output. */
export function runExtensionCli(cli: string, args: string[]) {
  const invocation = extensionCliInvocation(cli, args);
  return spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
}
