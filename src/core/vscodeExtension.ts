/**
 * Install the Showtail VS Code extension into VS Code (and code-insiders).
 *
 * VS Code's GitHub Copilot capture rides on the same Showtail extension the Antigravity
 * IDE uses (it watches the chat session files, snapshots saves, and adds an `@showtail`
 * chat participant). `connect copilot` / the auto-connect sweep install it hands-off via
 * VS Code's `code` CLI, using the `.vsix` shipped beside the Showtail binary — so a
 * student never has to run `code --install-extension` themselves.
 *
 * Mirrors `antigravityIdeExtension.ts` (shares `bundledVsixPath` / `ExtensionInstallResult`).
 * Everything is best-effort: if VS Code or the VSIX isn't found we return a reason and the
 * caller can fall back to guidance — we never throw.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { commandOnPath } from './detect.ts';
import {
  bundledVsixPath,
  type ExtensionInstallResult,
} from './antigravityIdeExtension.ts';

/** The VS Code Marketplace id — the offline `.vsix` is preferred; this is the fallback. */
export const VSCODE_EXTENSION_ID = 'Tingsters.showtail';

/**
 * Full paths to a VS Code CLI for installs where the `code` command isn't on PATH (very
 * common — VS Code doesn't add it by default). Covers stable and Insiders per platform.
 */
function cliCandidates(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'win32': {
      const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      const progs = process.env.ProgramFiles ?? 'C:\\Program Files';
      return [
        join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        join(progs, 'Microsoft VS Code', 'bin', 'code.cmd'),
        join(local, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
        '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
      ];
    default:
      return [
        '/usr/bin/code',
        '/usr/share/code/bin/code',
        '/snap/bin/code',
        join(home, '.local', 'bin', 'code'),
        '/usr/bin/code-insiders',
      ];
  }
}

/**
 * Locate a VS Code CLI, or null if VS Code isn't installed. Checks the
 * `SHOWTAIL_VSCODE_CLI` override (tests), then `code`/`code-insiders` on PATH, then the
 * platform app-bundle paths — so a normal VS Code install is found even without the CLI on
 * PATH. Returns a bare command (`code`) when on PATH, else an absolute path.
 */
export function findVsCodeCli(): string | null {
  const override = process.env.SHOWTAIL_VSCODE_CLI;
  if (override) return existsSync(override) ? override : null;
  for (const name of ['code', 'code-insiders']) {
    if (commandOnPath(name)) return name;
  }
  return cliCandidates().find((p) => existsSync(p)) ?? null;
}

/**
 * Install (or update, via `--force`) the Showtail extension into VS Code through its CLI,
 * preferring the bundled `.vsix` (offline, reliable) and falling back to the Marketplace id.
 * Never throws; returns a structured result so the caller can report success or print
 * manual guidance.
 */
export function installVsCodeExtension(): ExtensionInstallResult {
  const cli = findVsCodeCli();
  if (!cli) return { installed: false, reason: 'cli-not-found' };
  // Prefer the shipped VSIX; fall back to the Marketplace id only if it isn't bundled
  // (e.g. a bun/from-source dev run, where there's no VSIX beside the interpreter).
  const payload = bundledVsixPath() ?? VSCODE_EXTENSION_ID;

  const res = spawnSync(cli, ['--install-extension', payload, '--force'], {
    encoding: 'utf8',
  });
  if (res.status === 0) return { installed: true, cli, vsix: payload };
  return {
    installed: false,
    cli,
    vsix: payload,
    reason: (res.stderr || res.error?.message || `exit ${res.status ?? '?'}`).trim(),
  };
}
