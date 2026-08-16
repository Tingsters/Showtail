/**
 * Unit coverage for the maintainer live-certification harness
 * (`showtail matrix --verify-live`).
 *
 * The harness itself needs real tool binaries and a live model, so it only runs
 * behind `SHOWTAIL_LIVE=1` (see tests/live/capture.live.test.ts). These are the
 * pieces that can be checked offline — notably the Copilot version pick, which
 * is Windows-only in production and so would otherwise never be exercised.
 */
import { describe, expect, test } from 'bun:test';
import { byVersionDesc } from '../src/core/liveVerify.ts';

describe('liveVerify', () => {
  test('orders version dirs numerically, not lexicographically', () => {
    // The bug this pins: a plain .sort().reverse() puts "1.9.0" first, so the
    // harness would drive an older installed CLI and stamp its version into
    // matrix-verification.json as the certified one.
    expect(['1.9.0', '1.10.0', '1.2.0', '0.9.1'].sort(byVersionDesc)).toEqual([
      '1.10.0',
      '1.9.0',
      '1.2.0',
      '0.9.1',
    ]);
  });

  test('orders across a major-version rollover too', () => {
    expect(['9.0.0', '10.0.0'].sort(byVersionDesc)).toEqual(['10.0.0', '9.0.0']);
  });
});
