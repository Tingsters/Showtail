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
import { blockFor, parseBlock, writeIfChanged } from '../core/managedBlock.ts';
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
  'Showtail works with many AI coding tools, and support depth varies by tool. ' +
  'This table shows what each integration can do today — every ✅ is backed by an ' +
  'end-to-end test, so it genuinely works against the real tool.';

/** The anchor the matrix section is inserted before, the first integration section. */
const ANCHOR = '## Claude Code integration';

/**
 * Insert or refresh the matrix section in README. If the section already exists,
 * its heading, intro, and managed block are replaced atomically (so the intro —
 * which lives outside the markers — stays in sync); otherwise the whole section
 * is spliced in just before the first per-integration section.
 */
function writeReadme(): void {
  const file = readmePath();
  const body = renderMatrixMarkdown();
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const section = `${SECTION_HEADING}\n\n${SECTION_INTRO}\n\n${blockFor(body)}`;

  const block = parseBlock(current);
  const headingIdx = current.indexOf(SECTION_HEADING);
  if (block && headingIdx !== -1 && headingIdx < block.startIndex) {
    // Section already present — replace heading + intro + block atomically so the
    // intro (which lives outside the managed markers) stays in sync too.
    writeIfChanged(
      file,
      current.slice(0, headingIdx) + section + current.slice(block.endIndex),
    );
    return;
  }

  const idx = current.indexOf(ANCHOR);
  const next =
    idx === -1
      ? `${current.trimEnd()}\n\n${section}\n`
      : `${current.slice(0, idx)}${section}\n\n${current.slice(idx)}`;
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
