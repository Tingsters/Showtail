/**
 * The running Showtail version — single source for the CLI `--version` banner and
 * the wiring-version refresh (re-wire tools when the binary is newer than what last
 * wrote their capture hooks, so a student who never re-runs anything still gets
 * updated hooks). Keep in sync with `package.json` on release (same manual bump the
 * CLI banner already required).
 */
export const SHOWTAIL_VERSION = '0.12.0';
