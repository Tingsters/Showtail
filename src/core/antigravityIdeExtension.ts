/**
 * Install the Showtail VS Code extension into Google's Antigravity IDE.
 *
 * Antigravity is a VS Code fork, so capture rides on a real extension (it watches
 * the IDE's brain transcript and runs `showtail import antigravity-ide --auto`) —
 * far more reliable than the IDE's lifecycle hooks (only `PostToolUse` ever fires).
 * `connect antigravity-ide` therefore installs the extension via the IDE's own CLI
 * launcher, using the `.vsix` shipped next to the Showtail binary.
 *
 * Everything here is best-effort and side-effect-light: if the IDE or the bundled
 * VSIX isn't found we return a reason and the caller prints guidance — we never
 * throw, so `connect` still completes (instructions are written regardless).
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { runExtensionCli } from './extensionCli.ts';

/** The OpenVSX/Marketplace id, for manual installs and uninstall guidance. */
export const ANTIGRAVITY_EXTENSION_ID = 'tingsters.showtail';

/** Candidate on-disk paths for the Antigravity IDE CLI launcher, by platform. */
function cliCandidates(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'win32': {
      const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return [
        join(local, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
        join(local, 'Programs', 'Antigravity', 'bin', 'antigravity-ide.cmd'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity-ide',
        join(
          home,
          'Applications/Antigravity.app/Contents/Resources/app/bin/antigravity-ide',
        ),
      ];
    default:
      return [
        join(home, '.local', 'bin', 'antigravity-ide'),
        '/usr/local/bin/antigravity-ide',
        '/usr/bin/antigravity-ide',
        '/opt/Antigravity/bin/antigravity-ide',
      ];
  }
}

/**
 * Locate the Antigravity IDE CLI launcher, or null if the IDE isn't installed.
 * `SHOWTAIL_ANTIGRAVITY_CLI` overrides the search (tests / non-standard installs).
 */
export function findAntigravityIdeCli(): string | null {
  const override = process.env.SHOWTAIL_ANTIGRAVITY_CLI;
  if (override) return existsSync(override) ? override : null;
  return cliCandidates().find((p) => existsSync(p)) ?? null;
}

/**
 * The packaged Showtail `.vsix` shipped beside the binary, or null if absent.
 * `SHOWTAIL_VSIX` overrides the path (tests / dev runs, where `process.execPath`
 * is the bun/node binary rather than the compiled `showtail`).
 */
export function bundledVsixPath(): string | null {
  const override = process.env.SHOWTAIL_VSIX;
  if (override) return existsSync(override) ? override : null;
  const beside = join(dirname(process.execPath), 'showtail.vsix');
  return existsSync(beside) ? beside : null;
}

export interface ExtensionInstallResult {
  installed: boolean;
  cli?: string;
  vsix?: string;
  /** Why it didn't install: 'cli-not-found' | 'vsix-not-bundled' | a CLI error. */
  reason?: string;
}

/**
 * Install (or update, via `--force`) the Showtail VSIX into the Antigravity IDE
 * through its CLI launcher. Never throws; returns a structured result so the
 * caller can report success or fall back to printing manual instructions.
 */
export function installAntigravityIdeExtension(): ExtensionInstallResult {
  const cli = findAntigravityIdeCli();
  if (!cli) return { installed: false, reason: 'cli-not-found' };
  const vsix = bundledVsixPath();
  if (!vsix) return { installed: false, cli, reason: 'vsix-not-bundled' };

  const res = runExtensionCli(cli, ['--install-extension', vsix, '--force']);
  if (res.status === 0) return { installed: true, cli, vsix };
  return {
    installed: false,
    cli,
    vsix,
    reason: (res.stderr || res.error?.message || `exit ${res.status ?? '?'}`).trim(),
  };
}
