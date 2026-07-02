import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './storage.ts';

/**
 * Machine-wide Showtail state that lives *outside* any project: whether the
 * one-time `showtail setup` has run and whether automatic tracking is enabled.
 *
 * Deliberately stored under `~/.showtail-cli/`, NOT `~/.showtail`: the latter is
 * the per-project marker, and a `.showtail/` in HOME would make `findRoot` treat
 * the entire home directory as one project. The distinct name keeps the two
 * concepts from colliding. `SHOWTAIL_HOME` overrides the location so tests can
 * point it at a temp dir (mirrors the `SHOWTAIL_ROOT_CEILING` pattern).
 */
export interface GlobalConfig {
  /** Schema version, for upgrade-on-read. */
  version: number;
  /**
   * When true, a hook firing in an untracked but eligible folder silently
   * creates the trail (see the auto-init path in the hook handler). Off until
   * `showtail setup` turns it on, so a user who never ran setup is never
   * surprised by folders appearing.
   */
  autoInit?: boolean;
  /** ISO-8601 timestamp `showtail setup` last completed, if it has. */
  setupCompletedAt?: string;
}

/** The directory holding machine-wide Showtail config (not a project trail). */
export function showtailHome(): string {
  const override = process.env.SHOWTAIL_HOME;
  return override && override.length > 0 ? override : join(homedir(), '.showtail-cli');
}

/** Absolute path to the global config file. */
export function globalConfigPath(): string {
  return join(showtailHome(), 'config.json');
}

/**
 * Read the global config, tolerating a missing or corrupt file by returning a
 * safe default. Must never throw: it is read from inside the bulletproof hook
 * path, where any exception would risk disrupting the student's session.
 */
export function readGlobalConfig(): GlobalConfig {
  const file = globalConfigPath();
  if (!existsSync(file)) return { version: 1 };
  try {
    return readJson<GlobalConfig>(file);
  } catch {
    return { version: 1 };
  }
}

/** Persist the global config (atomic write; creates `~/.showtail-cli/` as needed). */
export function writeGlobalConfig(config: GlobalConfig): void {
  writeJson(globalConfigPath(), config);
}

/** Whether automatic tracking (silent auto-init on first AI use) is enabled. */
export function autoInitEnabled(): boolean {
  return readGlobalConfig().autoInit === true;
}
