/** Shared text helpers. */

/**
 * Collapse all runs of whitespace to single spaces, trim, and truncate to `max`
 * characters with a trailing ellipsis (so the result is at most `max` chars).
 * Used for the single-line previews in listings and the journal.
 */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Plural suffix: `''` for 1, `'s'` otherwise (e.g. `1 session` vs `2 sessions`). */
export function pluralS(n: number): string {
  return n === 1 ? '' : 's';
}

/**
 * The directory portion of a file path, handling both `/` and `\` separators
 * (so it works on Windows paths regardless of the running platform). Expects a
 * path that contains a separator (the absolute target paths we build always do).
 */
export function dirOf(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
}
