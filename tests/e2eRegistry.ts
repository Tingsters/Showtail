/**
 * The registry that links every `full` capability claim to a passing test.
 *
 * `E2E_TEST_IDS` is derived from the matrix itself: one id per `full` cell,
 * keyed `${capabilityId}:${integration}`. The backing suite
 * (capability-backing.test.ts) exercises each capability for real and calls
 * {@link markPassed} on success; the claims suite (capability-claims.test.ts)
 * then asserts every `full` cell has both a registered id and a passed marker.
 *
 * Markers are files under the OS temp dir so they survive across the separate
 * processes/files Bun runs — making the check order- and process-independent
 * within a single `bun test` run.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullClaims } from '../src/core/capabilityMatrix.ts';

/** Every test id that must pass for the matrix's `full` claims to be honest. */
export const E2E_TEST_IDS: string[] = fullClaims().map((c) => c.testId);

const MARKER_DIR = join(tmpdir(), 'showtail-e2e-passed');

/** Filenames can't contain ':' on Windows; encode it reversibly. */
function encode(id: string): string {
  return id.replace(/:/g, '__');
}
function decode(name: string): string {
  return name.replace(/__/g, ':');
}

/** Record that the end-to-end test backing `id` passed. */
export function markPassed(id: string): void {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(join(MARKER_DIR, encode(id)), '1', 'utf8');
}

/** The set of test ids marked passed so far in this run. */
export function passedIds(): Set<string> {
  if (!existsSync(MARKER_DIR)) return new Set();
  return new Set(readdirSync(MARKER_DIR).map(decode));
}

/** Drop all markers (called once before the backing suite runs). */
export function clearMarkers(): void {
  rmSync(MARKER_DIR, { recursive: true, force: true });
}
