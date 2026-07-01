/**
 * Shared UI helpers for the ledger-session list/pick commands (`inbox`, `move`):
 * a "how long ago" label, a per-session record summary, a one-line terminal
 * prompt, and an interactive numbered multi-select. Kept tool-agnostic so both
 * commands render the list their own way but reuse the mechanics.
 */
import { createInterface } from 'node:readline';
import { sessionSummary } from '../core/ledger.ts';
import { parseSelection } from './importClaude.ts';

/** A friendly "how long ago" label for an ISO timestamp. */
export function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/** Prompt/edit counts and the first prompt text across a session's records. */
export interface RecordSummary {
  prompts: number;
  edits: number;
  firstPrompt?: string;
}

export function summarize(sessionId: string): RecordSummary {
  return sessionSummary(sessionId);
}

/** Ask one line on the terminal (via stderr), returning the trimmed answer or a default. */
export function ask(question: string, def: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [${def}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

/**
 * Interactive numbered multi-select over an already-printed list of `items`.
 * Reads one line: numbers/ranges (`1,3`, `1-2`), `all`, or `q`/empty to cancel.
 * Returns the chosen items, or `null` if cancelled. Re-prompts once on bad input.
 */
export async function pickSessions<T>(items: T[], prompt: string): Promise<T[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await new Promise<string>((resolve) => {
          rl.question(`${prompt} `, resolve);
        })
      )
        .trim()
        .toLowerCase();
      if (answer === '' || answer === 'q' || answer === 'quit') return null;
      if (answer === 'all' || answer === '*') return items;
      const chosen = parseSelection(answer, items.length);
      if (chosen) return chosen.map((i) => items[i]!);
      process.stderr.write(
        `  Didn't understand that. Enter numbers between 1 and ${items.length} (e.g. 1,3), 'all', or q.\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Like {@link pickSessions} but also recognizes a **dismiss** verb, for the inbox
 * picker: a bare number list (`1,3`) / `all` means *place*; a `d`-prefixed form
 * (`d1,3`, `dismiss all`, or bare `d` for all) means *dismiss*. Returns the action
 * and the chosen items, or null to cancel (`q`/empty).
 */
export async function pickSessionsWithAction<T>(
  items: T[],
  prompt: string,
): Promise<{ action: 'place' | 'dismiss'; items: T[] } | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (
        await new Promise<string>((resolve) => {
          rl.question(`${prompt} `, resolve);
        })
      )
        .trim()
        .toLowerCase();
      if (answer === '' || answer === 'q' || answer === 'quit') return null;
      let action: 'place' | 'dismiss' = 'place';
      let sel = answer;
      const dismiss = answer.match(/^d(?:ismiss)?\s*(.*)$/);
      if (dismiss) {
        action = 'dismiss';
        sel = dismiss[1]!.trim() || 'all';
      }
      if (sel === 'all' || sel === '*') return { action, items: [...items] };
      const chosen = parseSelection(sel, items.length);
      if (chosen) return { action, items: chosen.map((i) => items[i]!) };
      process.stderr.write(
        `  Didn't understand that. Numbers 1–${items.length} (e.g. 1,3) or 'all' to place, ` +
          `'d1,3'/'dismiss all' to dismiss, or q.\n`,
      );
    }
    return null;
  } finally {
    rl.close();
  }
}
