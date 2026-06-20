/** Small, shared HTML helpers used by the report renderer and the highlighter. */

/** Escape the five characters that are unsafe in HTML text/attribute content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The first non-empty line of a string (for a card's collapsed summary). */
export function firstLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}
