/**
 * The keystone: a `full` capability claim is only allowed if a test proves it.
 *
 * Runs after capability-backing.test.ts (alphabetical file order), which marks
 * each exercised capability. Here we assert every `full` cell in the matrix has
 * a registered, *passed* contract test — and that every hook-driven capture cell
 * is additionally certified in the live-verification ledger. A new `full` claim
 * with no backing test fails this suite, so the matrix can never out-claim
 * reality.
 */
import { describe, expect, test } from 'bun:test';
import { fullClaims } from '../src/core/capabilityMatrix.ts';
import { ledgerHas, readLedger } from '../src/core/matrixLedger.ts';
import { E2E_TEST_IDS, passedIds } from './e2eRegistry.ts';

describe('every full capability claim is backed by a passing test', () => {
  const claims = fullClaims();
  const registered = new Set(E2E_TEST_IDS);

  test('there are full claims to check (guards against an empty matrix)', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  test('each full cell has a registered, passing contract test', () => {
    const passed = passedIds();
    const missing = claims.filter(
      (c) => !registered.has(c.testId) || !passed.has(c.testId),
    );
    // If this fails, either capability-backing.test.ts did not run/mark this id,
    // or a cell was set to `full` without adding its backing exercise.
    expect(missing.map((c) => c.testId)).toEqual([]);
  });

  test('each hook-driven capture cell is certified in the live ledger', () => {
    const ledger = readLedger();
    const missing = claims.filter((c) => c.liveRequired && !ledgerHas(ledger, c.testId));
    // If this fails, run `showtail matrix --verify-live` on a machine with the
    // tool installed to certify it, or demote the cell to `partial` until then.
    expect(missing.map((c) => c.testId)).toEqual([]);
  });
});
