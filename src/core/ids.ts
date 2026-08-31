import { randomBytes } from 'node:crypto';

/**
 * The known id prefixes — the single source of truth for the kinds of ids
 * Showtail mints. Typing {@link makeId} against this catches typos at every call
 * site without each one importing a constant.
 *  - `evt` events, `ses` sessions, `art` artifacts, `imp` import batches,
 *    `led` ledger sessions (the global durable store), `trl` trail ids (the
 *    stable per-repo identifier stamped into `.showtail/config.json`),
 *    `red` after-the-fact redaction passes (`showtail redact`), and `raw`
 *    structured provider conversation events, and `mig` migration batches/audits.
 */
export type IdPrefix =
  | 'evt'
  | 'ses'
  | 'art'
  | 'imp'
  | 'led'
  | 'trl'
  | 'red'
  | 'raw'
  | 'mig';

/**
 * Generate a short, sortable-ish, collision-resistant id with a type prefix,
 * e.g. `makeId('evt')` -> "evt_lqz3k8x2_9f1a".
 *
 * The middle segment is a base-36 timestamp (roughly time-ordered) and the
 * suffix is random, so ids are unique even within the same millisecond.
 * No external dependency required.
 */
export function makeId(prefix: IdPrefix): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}_${time}_${rand}`;
}
