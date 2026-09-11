/**
 * The running Showtail version — single source for the CLI `--version` banner and
 * the release-level wiring refresh. Must match `package.json` on release — the
 * compiled binary can't read `package.json`, so this constant is the only version
 * it knows. Managed instruction assets also have the independent revision below,
 * so they can refresh without waiting for semver to move.
 *
 * Enforced by `tests/version.test.ts`: 0.14.0 shipped with this left at `0.13.2`,
 * which silently disabled the release-level hook refresh (`wiringVersion` compared
 * equal, so upgraders kept their old capture wiring) — the bump is easy to forget
 * and nothing caught it.
 */
export const SHOWTAIL_VERSION = '0.17.1';

/**
 * Bump whenever bundled managed instructions or capture wiring changes. This is
 * deliberately independent of package semver so an asset-only fix refreshes an
 * existing integration even while development builds share the same version.
 */
export const MANAGED_INSTRUCTION_REVISION = 3;

/** Generation of transcript detail stored in project trails. */
export const HISTORY_GENERATION = 2;
