import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
  /**
   * Tools the opportunistic auto-connect sweep has already handled (connected, or
   * found already-connected). Each is processed at most once so a newly-installed
   * tool wires itself up without a manual `setup` re-run, while a tool the user
   * later disconnects is never re-installed against their wishes. See
   * `core/autoConnectSweep.ts`.
   */
  autoConnectedTools?: string[];
  /**
   * Folders the student has marked as scratch (`showtail ignore <path>`). Sessions
   * whose work lives under one never surface in `showtail inbox` — the override for
   * a folder that *is* a real project but the student treats as a sandbox. Absolute,
   * resolved paths.
   */
  scratchPaths?: string[];
  /**
   * Minimum activity for an otherwise-eligible inbox session to surface. A session
   * shows if it has at least this many edits OR prompts. Defaults to
   * {@link DEFAULT_INBOX_MIN_SIGNAL} when unset.
   */
  inboxMinSignal?: { edits: number; prompts: number };
  /**
   * Set-once watermark for "when Showtail started capturing here" (first `setup`,
   * or first auto-backfill if setup predates this feature). Never rewritten — unlike
   * {@link setupCompletedAt}, which every `setup` run overwrites. Auto-backfill of a
   * folderless chat whose newest message predates this is skipped (watch-forward:
   * don't resurrect pre-Showtail history). Purely go-forward.
   */
  captureSince?: string;
  /**
   * The Showtail version that last wired up tools (pre-seeded their capture hooks).
   * When the running binary is newer, the auto-connect path re-runs each tool's
   * `autoConnect` once to refresh its hooks to the current format — so a student who
   * never re-runs a Showtail command still gets hook updates on a binary upgrade.
   * The re-wire is an idempotent merge, so bumping this never duplicates hooks.
   */
  wiringVersion?: string;
}

/** Default signal floor for surfacing an inbox session (see {@link GlobalConfig.inboxMinSignal}). */
export const DEFAULT_INBOX_MIN_SIGNAL = { edits: 1, prompts: 2 };

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
 * The machine-local durable ledger directory. Every session is recorded here
 * first — before (and independent of) any project root resolving — so work from
 * a folderless/global tool, a scratch IDE workspace, or a zero-edit planning
 * session is never dropped. A repo's `.showtail/` is a *projection* of the
 * sessions the ledger placed there. Lives under {@link showtailHome} (never
 * inside a repo), so it never participates in git and may hold machine-local
 * absolute paths; the materialize step re-relativizes before anything lands in a
 * trail. `SHOWTAIL_HOME` relocates it for hermetic tests.
 */
export function ledgerDir(): string {
  return join(showtailHome(), 'ledger');
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

// --- inbox triage config --------------------------------------------------

/** The signal floor for surfacing an inbox session (config value or the default). */
export function readInboxMinSignal(): { edits: number; prompts: number } {
  return readGlobalConfig().inboxMinSignal ?? DEFAULT_INBOX_MIN_SIGNAL;
}

/** The user-marked scratch folders (absolute, resolved), or an empty list. */
export function readScratchPaths(): string[] {
  return readGlobalConfig().scratchPaths ?? [];
}

/** Add a folder to the scratch list (resolved + de-duplicated). Returns the new list. */
export function addScratchPath(path: string): string[] {
  const resolved = resolve(path);
  const cfg = readGlobalConfig();
  const next = Array.from(new Set([...(cfg.scratchPaths ?? []), resolved]));
  writeGlobalConfig({ ...cfg, scratchPaths: next });
  return next;
}

/** Remove a folder from the scratch list (by resolved path). Returns the new list. */
export function removeScratchPath(path: string): string[] {
  const resolved = resolve(path);
  const cfg = readGlobalConfig();
  const next = (cfg.scratchPaths ?? []).filter((p) => p !== resolved);
  writeGlobalConfig({ ...cfg, scratchPaths: next });
  return next;
}

// --- watch-forward watermark ----------------------------------------------

/** The set-once capture watermark, if one has been recorded. */
export function readCaptureSince(): string | undefined {
  return readGlobalConfig().captureSince;
}

/**
 * Record the capture watermark once. No-op (keeps the first value) if already set —
 * so an update / `setup` re-run never moves it. Returns the effective watermark.
 */
export function ensureCaptureSince(now: string = new Date().toISOString()): string {
  const cfg = readGlobalConfig();
  if (cfg.captureSince) return cfg.captureSince;
  writeGlobalConfig({ ...cfg, captureSince: now });
  return now;
}

/**
 * Whether an auto-backfill of a folderless conversation should be skipped: true
 * when a watermark exists and the conversation's newest message predates it. A
 * conversation with no known timestamp is never treated as stale (captured, then
 * hidden by the signal filter if trivial).
 */
export function isStaleForAutoBackfill(newestTs: string | undefined): boolean {
  const since = readCaptureSince();
  if (!since || !newestTs) return false;
  return newestTs < since;
}
