/** Bounded, consented discovery of existing Showtail project trails. */
import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { migrationPlugins } from '../plugins/registry.ts';
import { readGlobalConfig } from './globalConfig.ts';
import { readLedgerIndex } from './ledger.ts';
import { findRoot, isHomedirCatchAll, pathsForRoot, readConfig } from './storage.ts';

const PRUNE_NAMES = new Set([
  '.git',
  '.showtail',
  '.cache',
  '.claude',
  '.codex',
  '.copilot',
  '.gemini',
  '.showtail-cli',
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'Library',
  'AppData',
  '$Recycle.Bin',
]);

export interface DiscoveredProject {
  root: string;
  trailId?: string;
}

export interface ProjectDiscoveryResult {
  projects: DiscoveredProject[];
  duplicates: Array<{ trailId: string; paths: string[] }>;
  warnings: string[];
}

function pathKey(path: string): string {
  let value = resolve(path);
  try {
    value = realpathSync(value);
  } catch {
    // Missing paths retain their resolved spelling and are filtered later.
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function trailAt(root: string): DiscoveredProject | null {
  const paths = pathsForRoot(root);
  if (!existsSync(paths.config) || isHomedirCatchAll(root)) return null;
  try {
    const config = readConfig(paths);
    return { root: resolve(root), trailId: config.trailId };
  } catch {
    return null;
  }
}

function scanHome(
  home: string,
  add: (path: string) => void,
  warnings: string[],
  onProgress?: (directories: number) => void,
): void {
  let directories = 0;
  const walk = (dir: string): void => {
    directories += 1;
    if (directories % 250 === 0) onProgress?.(directories);
    if (existsSync(join(dir, '.showtail', 'config.json'))) add(dir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `Could not scan ${dir}: ${String((error as Error).message ?? error)}`,
      );
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (PRUNE_NAMES.has(entry.name)) continue;
      const child = join(dir, entry.name);
      try {
        if (lstatSync(child).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      walk(child);
    }
  };
  walk(home);
}

/** Discover known and home-contained trails after the user has opted into scanning. */
export function discoverShowtailProjects(
  options: {
    cwd?: string;
    home?: string;
    onProgress?: (directories: number) => void;
  } = {},
): ProjectDiscoveryResult {
  const warnings: string[] = [];
  const candidates = new Map<string, string>();
  const add = (path: string | undefined): void => {
    if (!path) return;
    const root = findRoot(path) ?? resolve(path);
    candidates.set(pathKey(root), root);
  };

  add(options.cwd);
  for (const project of readGlobalConfig().knownProjects ?? []) add(project.path);
  for (const trail of Object.values(readLedgerIndex().trails)) add(trail.path);
  for (const plugin of migrationPlugins()) {
    try {
      for (const candidate of plugin.migration.discover()) add(candidate.cwd);
    } catch (error) {
      warnings.push(`${plugin.label}: ${String((error as Error).message ?? error)}`);
    }
  }
  scanHome(resolve(options.home ?? homedir()), add, warnings, options.onProgress);

  const projects = [...candidates.values()]
    .map(trailAt)
    .filter((project): project is DiscoveredProject => project !== null)
    .sort((a, b) => a.root.localeCompare(b.root));

  const byTrail = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.trailId) continue;
    const list = byTrail.get(project.trailId) ?? [];
    list.push(project.root);
    byTrail.set(project.trailId, list);
  }
  const duplicates = [...byTrail.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([trailId, paths]) => ({ trailId, paths }));
  const duplicatePaths = new Set(duplicates.flatMap((duplicate) => duplicate.paths));

  return {
    projects: projects.filter((project) => !duplicatePaths.has(project.root)),
    duplicates,
    warnings,
  };
}

/** Project root from a discovered `.showtail/config.json` path. */
export function projectRootFromConfig(configPath: string): string {
  return dirname(dirname(configPath));
}

/** Friendly basename used by the bulk preview. */
export function projectLabel(root: string): string {
  return basename(root) || root;
}
