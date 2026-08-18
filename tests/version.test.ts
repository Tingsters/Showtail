/**
 * The version constant and `package.json` must agree.
 *
 * They are two separate manual edits, and 0.14.0 shipped with only one of them
 * done. That is not cosmetic: `SHOWTAIL_VERSION` is what a *compiled* binary
 * reports for `--version` (it cannot read `package.json`), and
 * `autoConnectSweep` re-wires a student's capture hooks only when the running
 * version differs from the `wiringVersion` that last wrote them — so a stale
 * constant silently withholds the hook refresh from everyone who upgrades.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWTAIL_VERSION } from '../src/core/version.ts';

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
});
