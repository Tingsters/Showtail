import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Canonicalize existing ancestors too, so missing paths retain symlink/8.3 identity. */
export function physicalPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(ancestor), ...suffix.reverse());
    } catch {
      /* Find the nearest existing ancestor. */
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    suffix.push(basename(ancestor));
    ancestor = parent;
  }
}

/** The one location for Showtail-owned data. Never depends on a project or cwd. */
export function dataHome(): string {
  const setting = process.env.SHOWTAIL_HOME?.trim();
  const expanded =
    setting === '~' ? homedir() : setting?.replace(/^~[\\/]/, homedir() + '/');
  if (expanded && !isAbsolute(expanded)) {
    throw new Error('SHOWTAIL_HOME must be an absolute path (or start with ~/).');
  }
  const home = resolve(expanded || join(homedir(), '.showtail'));
  const config = join(home, 'config.json');
  if (existsSync(config)) {
    let legacy = false;
    try {
      const value = JSON.parse(readFileSync(config, 'utf8'));
      legacy = typeof value.trailId === 'string' || typeof value.anchor === 'string';
    } catch {
      /* The configuration reader reports invalid JSON separately. */
    }
    if (legacy) {
      throw new Error(
        `LEGACY_HOME_CONFLICT: ${home} contains an old project trail. Set SHOWTAIL_HOME to another absolute directory, then run showtail import legacy --from "${home}". The original has not been changed.`,
      );
    }
  }
  return home;
}

export function ensureDataHome(): string {
  const home = dataHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function dataPath(...parts: string[]): string {
  const home = dataHome();
  const path = join(home, ...parts);
  const from = physicalPath(home);
  const to = physicalPath(path);
  const rel = relative(from, to);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error(
      'STORE_PATH_ESCAPE: a Showtail path leaves its configured storage directory.',
    );
  return path;
}
