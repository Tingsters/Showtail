/** One-time v1→v2 transcript-history migration offer. */
import { stdin, stdout } from 'node:process';
import {
  detectHistoryUpgrade,
  readGlobalConfig,
  setMigrationOffer,
} from '../core/globalConfig.ts';
import { HISTORY_GENERATION } from '../core/version.ts';
import { selfUpgrade } from '../core/selfUpgrade.ts';
import { emitJson } from '../core/output.ts';
import { askYesNo } from './migrate.ts';
import { runBulkMigration } from './migrateAll.ts';

export interface UpgradeOptions {
  json?: boolean;
}

/** Upgrade a standalone installer build to the latest GitHub Release. */
export async function runUpgrade(options: UpgradeOptions = {}): Promise<void> {
  const result = await selfUpgrade();
  if (options.json) {
    emitJson(result);
    return;
  }

  if (result.status === 'current') {
    console.log(`Showtail ${result.currentVersion} is already up to date.`);
    return;
  }
  if (result.status === 'newer') {
    console.log(
      `Showtail ${result.currentVersion} is newer than the latest release ` +
        `${result.latestVersion}; no changes made.`,
    );
    return;
  }
  if (result.status === 'pending') {
    console.log(
      `Downloaded Showtail ${result.latestVersion}. The Windows upgrade will finish ` +
        'after this command exits.',
    );
    return;
  }

  console.log(`Upgraded Showtail ${result.currentVersion} -> ${result.latestVersion}.`);
  console.log(`Installed at: ${result.targetPath}`);
  if (!result.integrationsRefreshed) {
    console.log('Capture integrations will refresh the next time Showtail runs.');
  }
}

export interface UpgradeOfferOptions {
  cwd?: string;
}

/** Offer the migration once when an existing install first runs generation 2. */
export async function maybeOfferHistoryMigration(
  options: UpgradeOfferOptions = {},
): Promise<boolean> {
  detectHistoryUpgrade(HISTORY_GENERATION);
  const offer = readGlobalConfig().migrationOffer;
  if (!offer || offer.generation !== HISTORY_GENERATION || offer.status !== 'pending') {
    return false;
  }
  if (!(stdin.isTTY && stdout.isTTY)) return false;

  console.log('');
  console.log(
    'Showtail v2 can recover tool calls and other details for your existing trails.',
  );
  const accepted = await askYesNo(
    'Scan for existing Showtail projects and migrate eligible history?',
  );
  if (!accepted) {
    setMigrationOffer({
      ...offer,
      status: 'declined',
      decidedAt: new Date().toISOString(),
    });
    console.log('Skipped. You can migrate any project later with `showtail migrate`.');
    return true;
  }

  setMigrationOffer({
    ...offer,
    status: 'running',
    decidedAt: new Date().toISOString(),
  });
  try {
    const result = await runBulkMigration({
      cwd: options.cwd,
      onRunCreated(runId) {
        setMigrationOffer({
          ...offer,
          status: 'running',
          decidedAt: new Date().toISOString(),
          bulkRunId: runId,
        });
      },
    });
    setMigrationOffer({
      ...offer,
      status: result.status === 'cancelled' ? 'declined' : 'completed',
      decidedAt: new Date().toISOString(),
      bulkRunId: result.runId,
    });
  } catch (error) {
    const current = readGlobalConfig().migrationOffer ?? offer;
    setMigrationOffer({ ...current, status: 'running' });
    console.error(
      `Migration stopped: ${String((error as Error).message ?? error)}. ` +
        'Run `showtail migrate` inside a missed project to recover it later.',
    );
  }
  return true;
}
