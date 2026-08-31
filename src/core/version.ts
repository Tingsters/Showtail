/**
 * The running Showtail version — single source for the CLI `--version` banner and
 * the wiring-version refresh (re-wire tools when the binary is newer than what last
 * wrote their capture hooks, so a student who never re-runs anything still gets
 * updated hooks). Must match `package.json` on release — the compiled binary can't
 * read `package.json`, so this constant is the only version it knows.
 *
 * Enforced by `tests/version.test.ts`: 0.14.0 shipped with this left at `0.13.2`,
 * which silently disabled the hook refresh above (`wiringVersion` compares equal,
 * so upgraders kept their old capture wiring) — the bump is easy to forget and
 * nothing caught it.
 */
export const SHOWTAIL_VERSION = '0.14.1';

/** Generation of transcript detail stored in project trails. */
export const HISTORY_GENERATION = 2;
