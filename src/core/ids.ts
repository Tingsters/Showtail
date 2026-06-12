import { randomBytes } from 'node:crypto';

/**
 * Generate a short, sortable-ish, collision-resistant id with a type prefix,
 * e.g. `makeId('evt')` -> "evt_lqz3k8x2_9f1a".
 *
 * The middle segment is a base-36 timestamp (roughly time-ordered) and the
 * suffix is random, so ids are unique even within the same millisecond.
 * No external dependency required.
 */
export function makeId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(3).toString('hex');
  return `${prefix}_${time}_${rand}`;
}
