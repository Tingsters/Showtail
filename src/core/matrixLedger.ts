/**
 * The matrix verification ledger (matrix-verification.json at the repo root).
 *
 * Contract tests (Tier A, in CI) prove each `full` cell against the real
 * contract. The hook-driven capture cells additionally require LLM-driven live
 * certification (Tier B): `showtail matrix --verify-live` drives the real tool
 * on this machine and records the result here. The ledger is committed so the
 * claims test can assert — in CI, without running anything live — that every
 * live-required cell was certified at least once, with which tool version and at
 * which commit. The change-aware re-run (scripts/verify-changed.ts) refreshes
 * the relevant entries whenever a backing feature changes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LedgerEntry {
  capability: string;
  integration: string;
  testId: string;
  /** 'live' = LLM-driven run; 'contract-exception' = no local LLM surface. */
  tier: 'live' | 'contract-exception';
  /** ISO-8601 time of certification (stamped by the caller, not in-script). */
  verifiedAt: string;
  /** Version string of the host tool that was driven, if known. */
  toolVersion?: string;
  /** Repo commit the certification ran against, if known. */
  commit?: string;
  /** Free-form note (e.g. why a contract-exception applies). */
  note?: string;
}

export interface Ledger {
  version: number;
  entries: LedgerEntry[];
}

export function ledgerPath(): string {
  return join(import.meta.dir, '..', '..', 'matrix-verification.json');
}

export function readLedger(): Ledger {
  const p = ledgerPath();
  if (!existsSync(p)) return { version: 1, entries: [] };
  return JSON.parse(readFileSync(p, 'utf8')) as Ledger;
}

export function writeLedger(ledger: Ledger): void {
  writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

export function ledgerHas(ledger: Ledger, testId: string): boolean {
  return ledger.entries.some((e) => e.testId === testId);
}

export function ledgerEntry(ledger: Ledger, testId: string): LedgerEntry | undefined {
  return ledger.entries.find((e) => e.testId === testId);
}

/** Insert or replace the entry for `entry.testId`, returning the new ledger. */
export function upsertEntry(ledger: Ledger, entry: LedgerEntry): Ledger {
  const entries = ledger.entries.filter((e) => e.testId !== entry.testId);
  entries.push(entry);
  entries.sort((a, b) => a.testId.localeCompare(b.testId));
  return { version: ledger.version || 1, entries };
}
