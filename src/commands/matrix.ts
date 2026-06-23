/**
 * `showtail matrix` (alias `integrations`) — print the integration capability
 * matrix: what works fully, partially, is planned, or can't be done for each AI
 * coding tool Showtail integrates with. `--json` emits the machine-readable
 * form; the hidden `--write-readme` regenerates the README's managed block from
 * the single source of truth in core/capabilityMatrix.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyManagedBlock,
  blockFor,
  parseBlock,
  writeIfChanged,
} from '../core/managedBlock.ts';
import { emitJson } from '../core/output.ts';
import { matrixJson, renderMatrixMarkdown } from '../core/capabilityMatrix.ts';
import {
  readLedger,
  upsertEntry,
  writeLedger,
  type LedgerEntry,
} from '../core/matrixLedger.ts';
import { runLiveVerification } from '../core/liveVerify.ts';

export interface MatrixOptions {
  json?: boolean;
  writeReadme?: boolean;
  verifyLive?: boolean;
  /** Restrict live verification to these integration ids (used by verify-changed). */
  only?: string[];
}

/** Path to the repository README (this command runs from source for maintainers). */
function readmePath(): string {
  return join(import.meta.dir, '..', '..', 'README.md');
}

const SECTION_HEADING = '## Integration capability matrix';
const SECTION_INTRO =
  'Support depth varies by integration. This matrix is generated from a single ' +
  'source of truth (`src/core/capabilityMatrix.ts`) and every ✅ cell is backed ' +
  'by an end-to-end test, so "fully implemented" means it works against the real ' +
  'tool. Regenerate with `showtail matrix --write-readme`.';

/** The anchor the matrix section is inserted before, the first integration section. */
const ANCHOR = '## Claude Code integration';

/**
 * Insert or refresh the matrix's managed block in README. If the block already
 * exists, {@link applyManagedBlock} refreshes it in place; otherwise the whole
 * section (heading + intro + block) is spliced in just before the first
 * per-integration section.
 */
function writeReadme(): void {
  const file = readmePath();
  const body = renderMatrixMarkdown();
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';

  if (parseBlock(current)) {
    // Block already present — refresh its contents in place (force: it's ours).
    applyManagedBlock(file, body, '', true);
    return;
  }

  const section = `${SECTION_HEADING}\n\n${SECTION_INTRO}\n\n${blockFor(body)}\n`;
  const idx = current.indexOf(ANCHOR);
  const next =
    idx === -1
      ? `${current.trimEnd()}\n\n${section}`
      : `${current.slice(0, idx)}${section}\n${current.slice(idx)}`;
  writeIfChanged(file, next);
}

/** Current short commit, for stamping ledger entries (best-effort). */
function currentCommit(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * Drive the live tools, certify the hook-based capture capabilities they
 * actually deliver, and record the results in the verification ledger. This is
 * the "run the full matrix once" certification (and, with `only`, the
 * change-aware re-run).
 */
function verifyLive(only?: string[]): void {
  const { results, certifiedTestIds } = runLiveVerification(only);
  const commit = currentCommit();
  const verifiedAt = new Date().toISOString();

  let ledger = readLedger();
  for (const r of results) {
    const line = r.available
      ? r.ok
        ? `✓ certified: ${r.certified.join(', ')}`
        : `✗ not certified — ${r.error}`
      : `– skipped — ${r.error}`;
    console.log(`${r.integration} (${r.toolVersion ?? 'unknown'}): ${line}`);
    for (const cap of r.certified) {
      const entry: LedgerEntry = {
        capability: cap,
        integration: r.integration,
        testId: `${cap}:${r.integration}`,
        tier: 'live',
        verifiedAt,
        toolVersion: r.toolVersion,
        commit,
      };
      ledger = upsertEntry(ledger, entry);
    }
  }
  writeLedger(ledger);
  console.log(
    `\nCertified ${certifiedTestIds.length} capability cell(s); ledger updated.`,
  );
}

export async function runMatrix(options: MatrixOptions = {}): Promise<void> {
  if (options.verifyLive) {
    verifyLive(options.only);
    return;
  }
  if (options.writeReadme) {
    writeReadme();
    console.log(`Updated ${readmePath()}`);
    return;
  }
  if (options.json) {
    emitJson(matrixJson());
    return;
  }
  console.log(renderMatrixMarkdown());
}
