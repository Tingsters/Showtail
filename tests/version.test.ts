/**
 * The version constant and `package.json` must agree.
 *
 * They are two separate manual edits, and 0.14.0 shipped with only one of them
 * done. That is not cosmetic: `SHOWTAIL_VERSION` is what a *compiled* binary
 * reports for `--version` (it cannot read `package.json`), and
 * `autoConnectSweep` uses it for release-level capture-hook refreshes (alongside
 * the independent managed-instruction revision), so a stale constant can still
 * withhold wiring fixes from everyone who upgrades.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_INSTRUCTION_REVISION, SHOWTAIL_VERSION } from '../src/core/version.ts';

describe('version', () => {
  test('SHOWTAIL_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    expect(pkg.version).toBeTruthy();
    expect(SHOWTAIL_VERSION).toBe(pkg.version!);
  });

  test('SHOWTAIL_VERSION is a plain semver triple', () => {
    // A release tag is `v${version}`, so anything else here breaks the tag/asset
    // naming the release workflow builds from.
    expect(SHOWTAIL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('managed instruction revision is a positive integer', () => {
    expect(Number.isInteger(MANAGED_INSTRUCTION_REVISION)).toBe(true);
    expect(MANAGED_INSTRUCTION_REVISION).toBeGreaterThan(0);
  });
});
