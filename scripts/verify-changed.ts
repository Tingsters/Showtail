/**
 * Change-aware live re-verification.
 *
 * The full live suite (`showtail matrix --verify-live`) certifies the whole
 * matrix once. This script keeps it honest as code changes: it maps the files
 * touched in the working tree (or a given base..HEAD range) to the integrations
 * whose live capture they affect, and re-runs the LLM-driven verification for
 * just those — refreshing their ledger entries.
 *
 *   bun run scripts/verify-changed.ts            # re-verify what changed now
 *   bun run scripts/verify-changed.ts --base origin/main
 *   bun run scripts/verify-changed.ts --check    # CI: fail if a cell is stale
 *
 * `--check` runs nothing live; it compares each live-certified cell's ledger
 * commit against the last commit that touched that integration's sources and
 * fails if the feature changed after its last certification — the signal to run
 * the re-verification before check-in.
 */
import { spawnSync } from 'node:child_process';
import { runMatrix } from '../src/commands/matrix.ts';
import { fullClaims } from '../src/core/capabilityMatrix.ts';
import { ledgerEntry, readLedger } from '../src/core/matrixLedger.ts';
import { LIVE_INTEGRATIONS } from '../src/core/liveVerify.ts';

/** Source files whose change should re-trigger an integration's live tests. */
const SOURCES: Record<string, string[]> = {
  'claude-code': [
    'src/plugins/claude-code.ts',
    'src/core/skill.ts',
    'src/core/claudeCode.ts',
    'src/core/hookInput.ts',
    'src/core/hook.ts',
    'src/commands/hook.ts',
    'src/core/liveVerify.ts',
  ],
  codex: [
    'src/plugins/codex.ts',
    'src/core/codex.ts',
    'src/core/hookInput.ts',
    'src/core/hook.ts',
    'src/commands/hook.ts',
    'src/core/liveVerify.ts',
  ],
};

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function changedFiles(base?: string): string[] {
  const set = new Set<string>();
  const add = (out: string) => out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((f) => set.add(f));
  if (base) {
    add(git(['diff', '--name-only', `${base}...HEAD`]));
  }
  add(git(['diff', '--name-only'])); // unstaged
  add(git(['diff', '--name-only', '--cached'])); // staged
  return [...set];
}

/** Integrations whose sources intersect the changed file set. */
function affectedIntegrations(changed: string[]): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const changedNorm = changed.map(norm);
  return LIVE_INTEGRATIONS.filter((id) =>
    (SOURCES[id] ?? []).some((src) => changedNorm.includes(src)),
  );
}

/** `--check`: fail if any live-certified cell's sources changed since it was certified. */
function checkStaleness(): number {
  const ledger = readLedger();
  const stale: string[] = [];
  for (const claim of fullClaims().filter((c) => c.liveRequired)) {
    const entry = ledgerEntry(ledger, claim.testId);
    if (!entry) {
      stale.push(`${claim.testId} (never certified)`);
      continue;
    }
    const sources = SOURCES[claim.integration] ?? [];
    // Stale iff a commit *after* the certified one touched the sources. (We only
    // gate on committed history here — uncommitted local edits are handled by the
    // default re-run mode, which diffs the working tree.)
    const changedSince = entry.commit
      ? git(['rev-list', `${entry.commit}..HEAD`, '--', ...sources]).trim()
      : '';
    if (changedSince) {
      const newest = changedSince.split('\n')[0]!.slice(0, 7);
      stale.push(`${claim.testId} (certified @ ${entry.commit}, sources changed @ ${newest})`);
    }
  }
  if (stale.length) {
    console.error('Stale live certifications — run `bun run verify:matrix` to refresh:');
    for (const s of stale) console.error(`  - ${s}`);
    return 1;
  }
  console.log('All live-certified cells are current.');
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    process.exit(checkStaleness());
  }

  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  const changed = changedFiles(base);
  const affected = affectedIntegrations(changed);

  if (affected.length === 0) {
    console.log('No changes affect a live-verified integration. Nothing to re-verify.');
    return;
  }
  console.log(`Changed sources affect: ${affected.join(', ')}. Re-verifying live…`);
  await runMatrix({ verifyLive: true, only: affected });
}

await main();
