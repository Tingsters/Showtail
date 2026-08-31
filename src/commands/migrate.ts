/** User-facing project transcript migration and undo commands. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { requireActiveAuthor } from '../core/authors.ts';
import { latestMigrationBatchId } from '../core/enrichments.ts';
import { removeJournalBatch } from '../core/events.ts';
import {
  migrateProject,
  type AmbiguousMigrationCandidate,
  type MigrationSessionResult,
  type ProjectMigrationResult,
} from '../core/migration.ts';
import { emitJson } from '../core/output.ts';
import { requirePaths } from '../core/storage.ts';
import type { Session } from '../types.ts';

export interface MigrateOptions {
  tool?: string;
  session?: string;
  file?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  cwd?: string;
  resume?: string;
}

export interface MigrateUndoOptions {
  batchId?: string;
  yes?: boolean;
  json?: boolean;
  cwd?: string;
}

function statusCounts(sessions: MigrationSessionResult[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.status, (counts.get(session.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ');
}

function printResult(result: ProjectMigrationResult): void {
  console.log(
    `${result.dryRun ? 'Migration preview' : 'Migration complete'} for ${result.root}`,
  );
  console.log(`  author: ${result.author}`);
  console.log(`  sessions: ${statusCounts(result.sessions) || 'none'}`);
  const recovered = Object.entries(result.totals)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
  console.log(`  recovered: ${recovered || 'nothing new'}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const session of result.sessions) {
    if (session.status !== 'ambiguous' && session.status !== 'error') continue;
    console.log(
      `  ${session.showtailSessionId}: ${session.status}${session.warnings.length ? ` — ${session.warnings.join('; ')}` : ''}`,
    );
  }
}

export async function askYesNo(question: string): Promise<boolean> {
  if (!(stdin.isTTY && stdout.isTTY)) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function candidateLine(candidate: AmbiguousMigrationCandidate, index: number): string {
  const span =
    candidate.first && candidate.last ? ` · ${candidate.first} → ${candidate.last}` : '';
  return (
    `  ${index + 1}) ${candidate.provider} ${candidate.providerSessionId}${span}\n` +
    `     ${candidate.firstPrompt ?? '(no prompt preview)'}`
  );
}

export function interactiveMatcher(
  remembered: Map<string, number | null>,
): (
  session: Session,
  candidates: AmbiguousMigrationCandidate[],
) => Promise<number | null> {
  return async (session, candidates) => {
    if (remembered.has(session.id)) return remembered.get(session.id)!;
    if (!(stdin.isTTY && stdout.isTTY)) return null;
    console.log('');
    console.log(
      `Showtail session ${session.id} has more than one plausible transcript match:`,
    );
    for (let i = 0; i < candidates.length; i += 1) {
      console.log(candidateLine(candidates[i]!, i));
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (
        await rl.question('Choose a transcript number, or press Enter to skip: ')
      ).trim();
      if (!/^\d+$/.test(answer)) {
        remembered.set(session.id, null);
        return null;
      }
      const selected = Number(answer) - 1;
      const value = candidates[selected] ? selected : null;
      remembered.set(session.id, value);
      return value;
    } finally {
      rl.close();
    }
  };
}

/** Migrate one project's active author from local provider transcripts. */
export async function runMigrate(options: MigrateOptions = {}): Promise<void> {
  if (options.resume) {
    const { runBulkMigration } = await import('./migrateAll.ts');
    await runBulkMigration({
      resumeId: options.resume,
      yes: options.yes,
      json: options.json,
    });
    return;
  }
  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });
  const remembered = new Map<string, number | null>();
  const confirmMatch =
    options.json || options.yes ? undefined : interactiveMatcher(remembered);

  if (options.dryRun) {
    const result = await migrateProject(author, {
      tool: options.tool,
      sessionId: options.session,
      file: options.file,
      dryRun: true,
      confirmMatch,
    });
    if (options.json) emitJson(result);
    else printResult(result);
    return;
  }

  if (!options.yes && !options.json) {
    const preview = await migrateProject(author, {
      tool: options.tool,
      sessionId: options.session,
      file: options.file,
      dryRun: true,
      confirmMatch,
    });
    printResult(preview);
    if (!preview.sessions.some((session) => session.status === 'planned')) return;
    if (!(await askYesNo('Apply this append-only migration?'))) {
      console.log('Nothing changed.');
      return;
    }
  }

  const result = await migrateProject(author, {
    tool: options.tool,
    sessionId: options.session,
    file: options.file,
    confirmMatch,
  });
  if (options.json) emitJson(result);
  else printResult(result);
}

/** Undo one migration batch, leaving a declared rewrite marker. */
export async function runMigrateUndo(options: MigrateUndoOptions = {}): Promise<void> {
  const paths = requirePaths(options.cwd);
  const author = await requireActiveAuthor(paths, { cwd: paths.root });
  const batchId = options.batchId ?? latestMigrationBatchId(author);
  if (!batchId) {
    if (options.json) emitJson({ removed: 0, batchId: null });
    else console.log('No migration batch was found for the active author.');
    return;
  }
  if (!options.yes && !options.json) {
    if (!(await askYesNo(`Undo migration batch ${batchId}?`))) {
      console.log('Nothing changed.');
      return;
    }
  }
  const removed = removeJournalBatch(author, batchId, 'migration-undo');
  if (options.json) emitJson({ removed, batchId });
  else console.log(`Removed ${removed} migration record(s) from batch ${batchId}.`);
}
