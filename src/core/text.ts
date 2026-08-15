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

/**
 * Truncate a block of (possibly multi-line) text to `maxChars`, noting how much
 * was cut. Applied before redaction, so a secret can't hide past the cutoff and
 * the stored/hashed object stays bounded (mirrors the existing cap on diffs).
 */
export function truncateBlock(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (truncated, ${text.length - maxChars} more characters)`;
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
