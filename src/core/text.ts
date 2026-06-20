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
