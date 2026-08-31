/** Cross-project discovery, preview, migration, and resume orchestration. */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeAuthorPaths } from '../core/authors.ts';
import { noteKnownProject, showtailHome } from '../core/globalConfig.ts';
import { makeId } from '../core/ids.ts';
import { migrateProject, type ProjectMigrationResult } from '../core/migration.ts';
import { discoverShowtailProjects, projectLabel } from '../core/projectDiscovery.ts';
import { emitJson } from '../core/output.ts';
import {
  pathsForRoot,
  readConfig,
  readJson,
  trailIsNewerThanBinary,
  writeJson,
} from '../core/storage.ts';
import { askYesNo, interactiveMatcher } from './migrate.ts';

export interface BulkMigrationOptions {
  cwd?: string;
  home?: string;
  yes?: boolean;
  json?: boolean;
  resumeId?: string;
  onRunCreated?: (runId: string) => void;
}

export interface BulkProjectResult {
  root: string;
  status: 'eligible' | 'migrated' | 'unchanged' | 'skipped' | 'error';
  reason?: string;
  migration?: ProjectMigrationResult;
}

export interface BulkMigrationResult {
  runId: string;
  status: 'preview' | 'completed' | 'cancelled' | 'interrupted';
  projects: BulkProjectResult[];
  duplicates: Array<{ trailId: string; paths: string[] }>;
  warnings: string[];
}

interface BulkMigrationManifest {
  version: 1;
  id: string;
  startedAt: string;
  updatedAt: string;
  status: BulkMigrationResult['status'];
  projectRoots: string[];
  projects: BulkProjectResult[];
  duplicates: BulkMigrationResult['duplicates'];
  warnings: string[];
}

function manifestsDir(): string {
  return join(showtailHome(), 'migrations');
}

function manifestPath(id: string): string {
  return join(manifestsDir(), `${id}.json`);
}

function writeManifest(manifest: BulkMigrationManifest): void {
  mkdirSync(manifestsDir(), { recursive: true });
  writeJson(manifestPath(manifest.id), manifest);
}

function readManifest(id: string): BulkMigrationManifest {
  const path = manifestPath(id);
  if (!existsSync(path)) throw new Error(`Bulk migration run "${id}" was not found.`);
  return readJson<BulkMigrationManifest>(path);
}

async function previewRoot(root: string): Promise<BulkProjectResult> {
  const paths = pathsForRoot(root);
  if (trailIsNewerThanBinary(paths)) {
    return { root, status: 'skipped', reason: 'trail is newer than this Showtail' };
  }
  const author = activeAuthorPaths(paths);
  if (!author) return { root, status: 'skipped', reason: 'no active local author' };
  try {
    noteKnownProject(root, readConfig(paths).trailId);
    const migration = await migrateProject(author, { dryRun: true });
    const eligible = migration.sessions.some((session) => session.status === 'planned');
    return {
      root,
      status: eligible ? 'eligible' : 'unchanged',
      migration,
    };
  } catch (error) {
    return { root, status: 'error', reason: String((error as Error).message ?? error) };
  }
}

function printPreview(result: BulkMigrationResult): void {
  console.log('');
  console.log('Showtail history migration preview');
  for (const project of result.projects) {
    const sessionCount =
      project.migration?.sessions.filter((session) => session.status === 'planned')
        .length ?? 0;
    console.log(
      `  ${projectLabel(project.root)} — ${project.status}${sessionCount ? ` (${sessionCount} session(s))` : ''}`,
    );
    if (project.reason) console.log(`    ${project.reason}`);
  }
  for (const duplicate of result.duplicates) {
    console.log(
      `  skipped copied trail ${duplicate.trailId}: ${duplicate.paths.join(', ')}`,
    );
  }
  console.log('');
}

async function applyRoot(
  root: string,
  remembered: Map<string, number | null>,
): Promise<BulkProjectResult> {
  const paths = pathsForRoot(root);
  const author = activeAuthorPaths(paths);
  if (!author) return { root, status: 'skipped', reason: 'no active local author' };
  try {
    const migration = await migrateProject(author, {
      confirmMatch: interactiveMatcher(remembered),
    });
    return {
      root,
      status: migration.sessions.some((session) => session.status === 'migrated')
        ? 'migrated'
        : 'unchanged',
      migration,
    };
  } catch (error) {
    return { root, status: 'error', reason: String((error as Error).message ?? error) };
  }
}

/** Discover and migrate all eligible projects after the upgrade offer is accepted. */
export async function runBulkMigration(
  options: BulkMigrationOptions = {},
): Promise<BulkMigrationResult> {
  let manifest: BulkMigrationManifest;
  if (options.resumeId) {
    manifest = readManifest(options.resumeId);
  } else {
    let progressShown = false;
    const discovery = discoverShowtailProjects({
      cwd: options.cwd,
      home: options.home,
      onProgress: options.json
        ? undefined
        : (directories) => {
            progressShown = true;
            process.stderr.write(
              `\rScanning for Showtail projects... ${directories} folders`,
            );
          },
    });
    if (progressShown) process.stderr.write('\n');
    const runId = makeId('mig');
    const projects: BulkProjectResult[] = [];
    for (const project of discovery.projects)
      projects.push(await previewRoot(project.root));
    manifest = {
      version: 1,
      id: runId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'preview',
      projectRoots: discovery.projects.map((project) => project.root),
      projects,
      duplicates: discovery.duplicates,
      warnings: discovery.warnings,
    };
    writeManifest(manifest);
    options.onRunCreated?.(runId);
  }

  let result: BulkMigrationResult = {
    runId: manifest.id,
    status: 'preview',
    projects: manifest.projects,
    duplicates: manifest.duplicates,
    warnings: manifest.warnings,
  };
  if (options.json && !options.yes) {
    emitJson(result);
    return result;
  }
  if (!options.json) printPreview(result);
  const eligibleRoots = manifest.projects
    .filter((project) => project.status === 'eligible')
    .map((project) => project.root);
  if (eligibleRoots.length === 0) {
    result.status = 'completed';
    writeManifest({
      ...manifest,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    });
    if (options.json) emitJson(result);
    else console.log('No eligible project history needs migration.');
    return result;
  }
  if (
    !options.yes &&
    !(await askYesNo(`Migrate ${eligibleRoots.length} eligible project(s)?`))
  ) {
    result.status = 'cancelled';
    writeManifest({
      ...manifest,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    if (options.json) emitJson(result);
    else console.log('Nothing changed.');
    return result;
  }

  const remembered = new Map<string, number | null>();
  const applied: BulkProjectResult[] = [];
  for (const root of eligibleRoots) {
    const project = await applyRoot(root, remembered);
    applied.push(project);
    const index = manifest.projects.findIndex((existing) => existing.root === root);
    if (index >= 0) manifest.projects[index] = project;
    manifest.updatedAt = new Date().toISOString();
    manifest.status = 'interrupted';
    writeManifest(manifest);
  }
  result = {
    runId: manifest.id,
    status: 'completed',
    projects: manifest.projects,
    duplicates: manifest.duplicates,
    warnings: manifest.warnings,
  };
  writeManifest({
    ...manifest,
    status: 'completed',
    updatedAt: new Date().toISOString(),
  });
  if (options.json) emitJson(result);
  else {
    console.log(
      `Migrated ${applied.filter((project) => project.status === 'migrated').length} project(s).`,
    );
  }
  return result;
}
