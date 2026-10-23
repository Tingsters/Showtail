/** Path comparisons that behave the same on every platform. */
import { relative, resolve, sep } from 'node:path';

/** A comparable key for a path: resolved, and lower-cased on Windows. */
export function pathKey(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Whether `child` is `parent` or nested beneath it (case-insensitive on win32). */
export function isPathUnder(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c === p || c.startsWith(prefix);
}

/** `filePath` relative to `root`, always with forward slashes. */
export function toRepoRelative(root: string, filePath: string): string {
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  return rel.split(sep).join('/');
}
