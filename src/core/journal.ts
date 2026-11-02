/** Read-only integrity checks for legacy journal imports. */
import type { JournalEntry } from '../types.ts';
import { digest } from './history.ts';

export function entryHash(entry: JournalEntry): string {
  return digest(
    JSON.stringify({ ...entry, v: typeof entry.v === 'number' ? entry.v : 1 }),
  );
}
export function checkChain(entries: JournalEntry[]): {
  breaks: { index: number; id: string; expected?: string; found?: string }[];
  unchained: number;
} {
  const breaks: { index: number; id: string; expected?: string; found?: string }[] = [];
  let unchained = 0;
  let expected: string | undefined;
  entries.forEach((entry, index) => {
    if (entry.prev === undefined) {
      if (index > 0) unchained++;
    } else if (entry.prev !== expected)
      breaks.push({ index: index + 1, id: entry.id, expected, found: entry.prev });
    expected = entryHash(entry);
  });
  return { breaks, unchained };
}
