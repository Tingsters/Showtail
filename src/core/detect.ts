import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** A tool Showtail can connect, and whether it appears to be installed. */
export interface DetectedTool {
  tool: 'claude' | 'copilot' | 'codex';
  installed: boolean;
}

/**
 * Is `name` an executable on the PATH? Pure filesystem check (no subprocess), so
 * it can't hang and is safe in any environment. Honors Windows' executable
 * extensions so `code`/`claude` resolve to `code.cmd`/`claude.exe` etc.
 */
function commandOnPath(name: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}

/** Does a config/home directory for the tool exist under the user's HOME? */
function homeDirExists(name: string): boolean {
  return existsSync(join(homedir(), name));
}

/**
 * Best-effort detection of which AI tools are installed, used by `showtail
 * setup` to decide what to connect. Read-only and quick: a tool is "installed"
 * if its launcher is on the PATH or it has left a config dir under HOME. False
 * negatives just mean setup connects fewer tools; the user can still
 * `showtail connect <tool>` later.
 */
export function detectTools(): DetectedTool[] {
  return [
    { tool: 'claude', installed: commandOnPath('claude') || homeDirExists('.claude') },
    {
      tool: 'copilot',
      installed: commandOnPath('code') || commandOnPath('code-insiders'),
    },
    { tool: 'codex', installed: commandOnPath('codex') || homeDirExists('.codex') },
  ];
}
