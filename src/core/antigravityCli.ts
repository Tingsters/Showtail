import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect antigravity-cli` is fully self-contained (no files to ship).
import AGY_BODY from '../../assets/antigravity-cli/AGY.showtail.md' with { type: 'text' };
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
import { dirOf } from './text.ts';

export { AGY_BODY };

export type InstallScope = 'user' | 'project';

// --- NON-COLLISION NOTES ----------------------------------------------------
// ~/.gemini is SHARED with the (now-EOL) gemini-cli plugin, which manages
// `~/.gemini/settings.json` (hooks map) and `GEMINI.md`. Codex manages
// `AGENTS.md`. To avoid clobbering any of those, this plugin uses DEDICATED,
// Antigravity-specific paths that the real `agy` CLI reads:
//   * Instructions: a uniquely-named rules file `AGY.showtail.md`, written into
//     the Antigravity-specific workspace `.agents/` dir (project) or the
//     `~/.gemini/antigravity-cli/` config dir (user). We never touch GEMINI.md
//     or AGENTS.md (owned by gemini-cli / codex respectively).
//   * Hooks: a dedicated `hooks.json` — `<root>/.agents/hooks.json` for a
//     workspace (the `.agents/` dir is Antigravity-only; the binary loads
//     "named hooks from hooks.json file(s)") and `~/.gemini/antigravity-cli/
//     hooks.json` globally (a distinct file from gemini-cli's settings.json).
// Both hooks files use the `{ hooks: { <Event>: [...] } }` map shape so the
// shared mergeHookEvents/unmergeHookEvents helpers apply unchanged.

/**
 * The canonical Antigravity CLI hook configuration, written into a dedicated
 * `hooks.json`. Antigravity's lifecycle events follow Claude Code's naming
 * (confirmed present in the `agy` binary: SessionStart, UserPromptSubmit,
 * PostToolUse, Stop), so the mapping is:
 *  - SessionStart    → session-start
 *  - UserPromptSubmit→ user-prompt (fires when the student submits a prompt)
 *  - PostToolUse     → post-edit   (matched to the file-writing tools)
 *  - Stop            → stop        (fires once per turn after the final response)
 * Antigravity edit tools use `file_path`-style payloads (write_file/replace/
 * edit), so the matcher targets those. Every command is tagged
 * `--tool antigravity-cli` so events are attributed correctly.
 */
export const ANTIGRAVITY_CLI_HOOK_EVENTS: HookEvents = {
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: 'showtail hook session-start --tool antigravity-cli',
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook user-prompt --tool antigravity-cli' },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'write_file|replace|edit',
      hooks: [
        { type: 'command', command: 'showtail hook post-edit --tool antigravity-cli' },
      ],
    },
  ],
  Stop: [
    {
      hooks: [{ type: 'command', command: 'showtail hook stop --tool antigravity-cli' }],
    },
  ],
};

/** The exact JSON text of an Antigravity `hooks.json` (for asset-sync tests). */
export function antigravityCliHooksJson(): string {
  return JSON.stringify({ hooks: ANTIGRAVITY_CLI_HOOK_EVENTS }, null, 2) + '\n';
}

export interface AntigravityCliTarget {
  scope: InstallScope;
  /**
   * The Antigravity config/workspace dir holding our hooks + instructions.
   * user: ~/.gemini/antigravity-cli, project: <root>/.agents
   */
  configDir: string;
  /** Dedicated hooks file Antigravity reads our lifecycle hooks from. */
  hooksFile: string;
  /** Dedicated, uniquely-named rules/instructions file (never GEMINI.md/AGENTS.md). */
  contextFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user: ~/.gemini/antigravity-cli/{hooks.json,AGY.showtail.md}
 *  - project: <root>/.agents/{hooks.json,AGY.showtail.md}
 */
export function resolveAntigravityCliTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): AntigravityCliTarget {
  const configDir =
    scope === 'user'
      ? join(homedir(), '.gemini', 'antigravity-cli')
      : join(findRoot(cwd) ?? cwd, '.agents');
  return {
    scope,
    configDir,
    hooksFile: join(configDir, 'hooks.json'),
    contextFile: join(configDir, 'AGY.showtail.md'),
  };
}

// --- Instructions (managed block in AGY.showtail.md) -----------------------

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/** Install or refresh the Showtail managed block in the instructions file. */
export function writeAntigravityCliInstructions(
  target: AntigravityCliTarget,
  options: WriteOptions = {},
): void {
  mkdirSync(dirOf(target.contextFile), { recursive: true });
  // The instructions file has no frontmatter, so the preamble is empty.
  applyManagedBlock(target.contextFile, AGY_BODY, '', options.force ?? false);
}

export interface AntigravityCliInstructionsState {
  installed: boolean;
  upToDate: boolean;
  userEdited: boolean;
  updateAvailable: boolean;
}

const ABSENT: AntigravityCliInstructionsState = {
  installed: false,
  upToDate: false,
  userEdited: false,
  updateAvailable: false,
};

/** Inspect the instructions managed block and classify it for status/refresh. */
export function antigravityCliInstructionsState(
  target: AntigravityCliTarget,
): AntigravityCliInstructionsState {
  if (!existsSync(target.contextFile)) return ABSENT;
  const parsed = parseBlock(readFileSync(target.contextFile, 'utf8'));
  if (!parsed) return ABSENT;
  const cls = classify(parsed, AGY_BODY);
  if (cls === 'edited') {
    return {
      installed: true,
      upToDate: false,
      userEdited: true,
      updateAvailable: parsed.sha !== shortHash(AGY_BODY),
    };
  }
  if (cls === 'stale') {
    return { installed: true, upToDate: false, userEdited: false, updateAvailable: true };
  }
  return { installed: true, upToDate: true, userEdited: false, updateAvailable: false };
}

/** Remove the Showtail block from the instructions file (deletes it if it empties). */
export function removeAntigravityCliInstructions(target: AntigravityCliTarget): boolean {
  return stripManagedBlock(target.contextFile, () =>
    rmSync(target.contextFile, { force: true }),
  );
}

// --- Hooks (dedicated hooks.json) ------------------------------------------

/** Read a `hooks.json` as a settings-shaped object, or `{}` if absent. */
function readHooksFile(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return {};
  try {
    return readJson<Record<string, unknown>>(hooksFile);
  } catch {
    return {};
  }
}

/** Install (or refresh) the Antigravity CLI hooks in the target's hooks.json. */
export function installAntigravityCliHooks(target: AntigravityCliTarget): string {
  const merged = mergeHookEvents(
    readHooksFile(target.hooksFile),
    ANTIGRAVITY_CLI_HOOK_EVENTS,
  );
  writeJson(target.hooksFile, merged);
  return target.hooksFile;
}

/** Remove the Antigravity CLI hooks from the target's hooks.json (if present). */
export function uninstallAntigravityCliHooks(target: AntigravityCliTarget): boolean {
  if (!existsSync(target.hooksFile)) return false;
  writeJson(target.hooksFile, unmergeHookEvents(readHooksFile(target.hooksFile)));
  return true;
}

/** Does this hooks.json contain our auto-capture hooks? */
export function antigravityCliHooksInstalledAt(hooksFile: string): boolean {
  if (!existsSync(hooksFile)) return false;
  try {
    return hasOurHooks(readJson<Record<string, unknown>>(hooksFile));
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's Antigravity CLI hooks are active for work in `cwd` — true
 * if they're installed at either project or user scope.
 */
export function antigravityCliAutoCaptureActive(cwd: string = process.cwd()): boolean {
  return (
    antigravityCliHooksInstalledAt(
      resolveAntigravityCliTarget('project', cwd).hooksFile,
    ) ||
    antigravityCliHooksInstalledAt(resolveAntigravityCliTarget('user', cwd).hooksFile)
  );
}
