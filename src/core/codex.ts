import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect codex` is fully self-contained (no files to ship).
import AGENTS_BODY from '../../assets/codex/AGENTS.showtail.md' with { type: 'text' };
import {
  hasOurHooks,
  mergeHookEvents,
  unmergeHookEvents,
  type HookEvents,
} from './hookMerge.ts';
import {
  applyManagedBlock,
  classify,
  parseBlock,
  shortHash,
  stripManagedBlock,
} from './managedBlock.ts';
import { findRoot, readJson, writeJson } from './storage.ts';

export { AGENTS_BODY };

export type InstallScope = 'user' | 'project';

/**
 * The canonical Codex hook configuration. Mirrors Claude Code's `HOOK_EVENTS`
 * but every command is tagged `--tool codex` (so recorded events/artifacts are
 * attributed to Codex) and PostToolUse matches Codex's `apply_patch` tool
 * rather than Claude's `Edit|Write|MultiEdit`.
 */
export const CODEX_HOOK_EVENTS: HookEvents = {
  SessionStart: [
    { hooks: [{ type: 'command', command: 'showtail hook session-start --tool codex' }] },
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'showtail hook user-prompt --tool codex' }] },
  ],
  PostToolUse: [
    {
      matcher: 'apply_patch',
      hooks: [{ type: 'command', command: 'showtail hook post-edit --tool codex' }],
    },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop --tool codex' }] }],
};

/** The exact JSON text of a `.codex/hooks.json` (for the asset-sync test). */
export function codexHooksJson(): string {
  return JSON.stringify({ hooks: CODEX_HOOK_EVENTS }, null, 2) + '\n';
}

export interface CodexTarget {
  scope: InstallScope;
  /** The `.codex` directory (user: ~/.codex, project: <root>/.codex). */
  codexDir: string;
  /** Lifecycle hooks file. */
  hooksFile: string;
  /** Codex config; we toggle `features.hooks` here. */
  configToml: string;
  /** Persistent instructions (user: ~/.codex/AGENTS.md, project: <root>/AGENTS.md). */
  agentsFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user: ~/.codex/{hooks.json,config.toml,AGENTS.md}
 *  - project: <root>/.codex/{hooks.json,config.toml} and <root>/AGENTS.md
 */
export function resolveCodexTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): CodexTarget {
  const base = scope === 'user' ? homedir() : (findRoot(cwd) ?? cwd);
  const codexDir = join(base, '.codex');
  return {
    scope,
    codexDir,
    hooksFile: join(codexDir, 'hooks.json'),
    configToml: join(codexDir, 'config.toml'),
    agentsFile: scope === 'user' ? join(codexDir, 'AGENTS.md') : join(base, 'AGENTS.md'),
  };
}

// --- Instructions (managed block in AGENTS.md) -----------------------------

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/** Install or refresh the Showtail managed block in AGENTS.md. */
export function writeCodexInstructions(
  target: CodexTarget,
  options: WriteOptions = {},
): void {
  mkdirSync(findDir(target.agentsFile), { recursive: true });
  // AGENTS.md has no frontmatter, so the preamble is empty.
  applyManagedBlock(target.agentsFile, AGENTS_BODY, '', options.force ?? false);
}

function findDir(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
}

export interface CodexInstructionsState {
  installed: boolean;
  upToDate: boolean;
  userEdited: boolean;
  updateAvailable: boolean;
}

/** Inspect the AGENTS.md managed block and classify it for status/refresh. */
export function codexInstructionsState(target: CodexTarget): CodexInstructionsState {
  if (!existsSync(target.agentsFile)) {
    return {
      installed: false,
      upToDate: false,
      userEdited: false,
      updateAvailable: false,
    };
  }
  const parsed = parseBlock(readFileSync(target.agentsFile, 'utf8'));
  if (!parsed) {
    return {
      installed: false,
      upToDate: false,
      userEdited: false,
      updateAvailable: false,
    };
  }
  const cls = classify(parsed, AGENTS_BODY);
  if (cls === 'edited') {
    return {
      installed: true,
      upToDate: false,
      userEdited: true,
      updateAvailable: parsed.sha !== shortHash(AGENTS_BODY),
    };
  }
  if (cls === 'stale') {
    return { installed: true, upToDate: false, userEdited: false, updateAvailable: true };
  }
  return { installed: true, upToDate: true, userEdited: false, updateAvailable: false };
}

/** Remove the Showtail block from AGENTS.md (deletes the file if it empties). */
export function removeCodexInstructions(target: CodexTarget): boolean {
  return stripManagedBlock(target.agentsFile, () =>
    rmSync(target.agentsFile, { force: true }),
  );
}

// --- Hooks (.codex/hooks.json) ---------------------------------------------

/** Read a `.codex/hooks.json` as a settings-shaped object, or `{}` if absent. */
function readHooksFile(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return {};
  try {
    return readJson<Record<string, unknown>>(hooksFile);
  } catch {
    return {};
  }
}

/** Install (or refresh) the Codex hooks in the target's hooks.json. */
export function installCodexHooks(target: CodexTarget): string {
  const merged = mergeHookEvents(readHooksFile(target.hooksFile), CODEX_HOOK_EVENTS);
  writeJson(target.hooksFile, merged);
  return target.hooksFile;
}

/** Remove the Codex hooks from the target's hooks.json (if present). */
export function uninstallCodexHooks(target: CodexTarget): boolean {
  if (!existsSync(target.hooksFile)) return false;
  writeJson(target.hooksFile, unmergeHookEvents(readHooksFile(target.hooksFile)));
  return true;
}

/** Does this hooks.json contain our auto-capture hooks? */
export function codexHooksInstalledAt(hooksFile: string): boolean {
  if (!existsSync(hooksFile)) return false;
  try {
    return hasOurHooks(readJson<Record<string, unknown>>(hooksFile));
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's Codex hooks are active for work in `cwd` — true if they're
 * installed at either project or user scope.
 */
export function codexAutoCaptureActive(cwd: string = process.cwd()): boolean {
  return (
    codexHooksInstalledAt(resolveCodexTarget('project', cwd).hooksFile) ||
    codexHooksInstalledAt(resolveCodexTarget('user', cwd).hooksFile)
  );
}

// --- config.toml `features.hooks` enablement -------------------------------
// We deliberately avoid a full TOML parser (no dependency, and a reserialize
// would churn the user's comments/formatting). Instead we do a small, targeted
// text edit that handles the common shapes and never clobbers other keys.

/** Strip a trailing TOML comment and surrounding whitespace from a value. */
function valueToken(rest: string): string {
  const hash = rest.indexOf('#');
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/** Read the current `features.hooks` value, or undefined if unset. */
export function codexHooksFeatureEnabled(configToml: string): boolean {
  if (!existsSync(configToml)) return false;
  const lines = readFileSync(configToml, 'utf8').split('\n');
  let table: string | undefined;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const dotted = line.match(/^\s*features\.hooks\s*=\s*(.*)$/);
    if (dotted) return valueToken(dotted[1]!) === 'true';
    if (table === 'features') {
      const hk = line.match(/^\s*hooks\s*=\s*(.*)$/);
      if (hk) return valueToken(hk[1]!) === 'true';
    }
  }
  return false;
}

export type EnableResult = 'created' | 'updated' | 'unchanged';

/**
 * Ensure `features.hooks = true` in config.toml without clobbering anything
 * else. Flips an existing key in place (dotted or under `[features]`), inserts
 * the key into an existing `[features]` table, or appends a `[features]` table.
 */
export function enableCodexHooksFeature(configToml: string): EnableResult {
  if (!existsSync(configToml)) {
    mkdirSync(findDir(configToml), { recursive: true });
    writeFileSync(configToml, '[features]\nhooks = true\n', 'utf8');
    return 'created';
  }

  const content = readFileSync(configToml, 'utf8');
  const lines = content.split('\n');
  let table: string | undefined;
  let featuresHeaderIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = line.match(/^(\s*)\[([^\]]+)\]\s*$/);
    if (header) {
      table = header[2]!.trim();
      if (table === 'features' && featuresHeaderIdx === -1) featuresHeaderIdx = i;
      continue;
    }
    const dotted = line.match(/^(\s*)features\.hooks(\s*)=\s*(.*)$/);
    if (dotted) {
      if (valueToken(dotted[3]!) === 'true') return 'unchanged';
      lines[i] = `${dotted[1]}features.hooks${dotted[2]}= true`;
      writeFileSync(configToml, lines.join('\n'), 'utf8');
      return 'updated';
    }
    if (table === 'features') {
      const hk = line.match(/^(\s*)hooks(\s*)=\s*(.*)$/);
      if (hk) {
        if (valueToken(hk[3]!) === 'true') return 'unchanged';
        lines[i] = `${hk[1]}hooks${hk[2]}= true`;
        writeFileSync(configToml, lines.join('\n'), 'utf8');
        return 'updated';
      }
    }
  }

  if (featuresHeaderIdx !== -1) {
    // Insert the key right after the existing [features] header.
    lines.splice(featuresHeaderIdx + 1, 0, 'hooks = true');
    writeFileSync(configToml, lines.join('\n'), 'utf8');
    return 'updated';
  }

  // No [features] table at all — append one.
  const sep = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  writeFileSync(configToml, content + sep + '\n[features]\nhooks = true\n', 'utf8');
  return 'updated';
}
