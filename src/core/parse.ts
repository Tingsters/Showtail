/**
 * Tiny runtime helpers for reading fields off untrusted, loosely-typed JSON
 * (share-page payloads, transcript lines) without resorting to `any`. Each
 * returns a narrowed value or `undefined`, so navigation stays total — a
 * missing or mis-shaped field is never a throw. That matches the parsers'
 * contract: degrade to the paste/skip fallback, never crash a session.
 */

/** True for a non-null object — arrays included, mirroring `typeof x === 'object'`. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read `value[key]` when `value` is a non-null object; `undefined` otherwise. */
export function prop(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** `value` if it is a string, else `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` if it is a number, else `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** `value` if it is an array, else `undefined`. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
