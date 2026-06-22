import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Low-level, tool-agnostic detection helpers. Each connect plugin uses these to
// implement its own `detect()`; this module knows nothing about specific tools.

/**
 * Is `name` an executable on the PATH? Pure filesystem check (no subprocess), so
 * it can't hang and is safe in any environment. Honors Windows' executable
 * extensions so `code`/`claude` resolve to `code.cmd`/`claude.exe` etc.
 */
export function commandOnPath(name: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}

/** Does a config/home directory `name` (e.g. '.claude') exist under HOME? */
export function homeDirExists(name: string): boolean {
  return existsSync(join(homedir(), name));
}
