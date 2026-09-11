import { posix, win32 } from 'node:path';

/** An old-root -> new-root mapping for paths whose project moved. */
export interface PathRebase {
  fromRoot: string;
  toRoot: string;
}

export type RebasePathStyle = 'posix' | 'win32';

/** Platform-explicit rebase core, exported so both path styles are testable everywhere. */
export function applyRebaseForPathStyle(
  rebase: PathRebase,
  oldAbs: string,
  style: RebasePathStyle,
): string | undefined {
  const paths = style === 'win32' ? win32 : posix;
  const fromResolved = paths.resolve(rebase.fromRoot);
  const toResolved = paths.resolve(rebase.toRoot);
  const targetResolved = paths.resolve(oldAbs);
  const key = (value: string) => (style === 'win32' ? value.toLowerCase() : value);
  const from = key(fromResolved);
  const to = key(toResolved);
  const target = key(targetResolved);
  const prefix = from.endsWith(paths.sep) ? from : from + paths.sep;
  const toPrefix = to.endsWith(paths.sep) ? to : to + paths.sep;

  // A later capture already under a nested destination must not be moved there twice.
  if (
    (to === from || to.startsWith(prefix)) &&
    (target === to || target.startsWith(toPrefix))
  ) {
    return undefined;
  }

  if (target === from) return toResolved;
  if (!target.startsWith(prefix)) return undefined;

  // Strip the leading separator so joining cannot reset to the filesystem root.
  let suffix = targetResolved.slice(fromResolved.length);
  while (suffix.startsWith(paths.sep)) suffix = suffix.slice(paths.sep.length);
  return paths.join(toResolved, suffix);
}

/** Re-point one stale absolute path, or return undefined when it is outside the mapping. */
export function applyRebase(rebase: PathRebase, oldAbs: string): string | undefined {
  return applyRebaseForPathStyle(
    rebase,
    oldAbs,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
}

/** Apply a session's relocation history in order while leaving unrelated paths unchanged. */
export function applyPathRebases(
  rebases: readonly PathRebase[] | undefined,
  path: string,
): string {
  let current = path;
  for (const rebase of rebases ?? []) {
    current = applyRebase(rebase, current) ?? current;
  }
  return current;
}
