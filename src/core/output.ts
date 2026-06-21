/**
 * Shared helper for the `--json` output mode. Every command that supports
 * `--json` prints exactly one pretty-printed (2-space) JSON document through
 * this, so an agent gets a single, deterministic object on stdout — matching the
 * shape `showtail status --json` has always used.
 */
export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
