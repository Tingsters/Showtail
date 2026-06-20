import { escapeHtml } from '../html.ts';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A readable, locale-independent UTC rendering (e.g. `20 Jun 2026, 21:30 UTC`).
 * Mirrors the timezone script's `20 Jun 2026, 14:30` style but keeps the `UTC`
 * marker, since this is the static fallback shown wherever that script can't run
 * (the Markdown export, printing, and HTML viewed with JavaScript disabled) and
 * there is no selector bar to state the zone.
 */
export function staticUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace(/\.\d{3}Z$/, 'Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * A placeholder for a timestamp in the Markdown-for-HTML stream. It uses no
 * Markdown-special characters, so it survives `markdownToHtml` untouched and is
 * swapped for a real `<time>` element by {@link renderHtml}. ISO instants never
 * contain `@`, so the delimiter is unambiguous.
 */
export function timeToken(iso: string): string {
  return `SHOWTAILTIME@${iso}@`;
}

/** Matches {@link timeToken} output for the post-Markdown swap to `<time>` tags. */
export const TIME_TOKEN = /SHOWTAILTIME@([^@]+)@/g;

/**
 * A `<time>` element carrying the raw UTC instant plus a static UTC fallback.
 * The inline timezone script re-renders its text in the viewer's chosen zone;
 * with JavaScript off it still reads as a valid UTC timestamp.
 */
export function timeTag(iso: string): string {
  return `<time class="st-time" datetime="${escapeHtml(iso)}">${escapeHtml(staticUtc(iso))}</time>`;
}
