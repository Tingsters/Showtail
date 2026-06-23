import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect antigravity-cli` is fully self-contained (no files to ship).
import AGY_BODY from '../../assets/antigravity-cli/AGY.showtail.md' with { type: 'text' };
import type { HookEvents } from './hookMerge.ts';
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

// --- HOOK FORMAT (verified live against the real `agy` 1.0.10) ---------------
// Antigravity CLI reads JSON hooks from `hooks.json` files it auto-loads from:
//   * workspace: `<root>/.agents/hooks.json`
//   * global:    `~/.gemini/config/hooks.json`  (next to `mcp_config.json`)
// The schema is NOT Claude's `{ hooks: { <Event>: [...] } }`. It is a map of
// NAMED config blocks, each with an `enabled` flag and event-name keys:
//   { "showtail": { "enabled": true, "<Event>": [ { matcher?, hooks:[{type,command}] } ] } }
// Its lifecycle events differ too — there is NO `UserPromptSubmit`. We use:
//   * SessionStart  → session-start
//   * PreInvocation → user-prompt (fires before inference; carries the prompt)
//   * PostToolUse   → post-edit   (matched to the file-writing tools)
//   * Stop          → stop        (reconcile the transcript)
// agy runs a hook's `command` through cmd.exe and execs the FIRST token, so the
// command must be a BARE `showtail` on PATH (no quotes/paths) — quoted paths fail.
// agy's PostToolUse payload is `{ toolCall:{name,args:{TargetFile,CodeContent,…}},
// transcriptPath, conversationId, workspacePaths }` (parsed in the plugin adapter).

/** Top-level config-block name we own in agy's hooks.json. */
export const ANTIGRAVITY_BLOCK_NAME = 'showtail';

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
  PreInvocation: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook user-prompt --tool antigravity-cli' },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher:
        'write_to_file|replace_file_content|multi_replace_file_content|edit|create_file',
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

/** The `showtail` block exactly as it appears inside agy's hooks.json. */
export function antigravityCliBlock(): Record<string, unknown> {
  return { enabled: true, ...ANTIGRAVITY_CLI_HOOK_EVENTS };
}

/** The exact JSON text of a fresh Antigravity `hooks.json` (for asset-sync tests). */
export function antigravityCliHooksJson(): string {
  return (
    JSON.stringify({ [ANTIGRAVITY_BLOCK_NAME]: antigravityCliBlock() }, null, 2) + '\n'
  );
}

export interface AntigravityCliTarget {
  scope: InstallScope;
  /** The `hooks.json` agy auto-loads for this scope. */
  hooksFile: string;
  /** Dedicated, uniquely-named rules/instructions file (never GEMINI.md/AGENTS.md). */
  contextFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user:    hooks `~/.gemini/config/hooks.json`, rules `~/.gemini/antigravity-cli/AGY.showtail.md`
 *  - project: hooks `<root>/.agents/hooks.json`,   rules `<root>/.agents/AGY.showtail.md`
 */
export function resolveAntigravityCliTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): AntigravityCliTarget {
  if (scope === 'user') {
    const gemini = join(homedir(), '.gemini');
    return {
      scope,
      hooksFile: join(gemini, 'config', 'hooks.json'),
      contextFile: join(gemini, 'antigravity-cli', 'AGY.showtail.md'),
    };
  }
  const agents = join(findRoot(cwd) ?? cwd, '.agents');
  return {
    scope,
    hooksFile: join(agents, 'hooks.json'),
    contextFile: join(agents, 'AGY.showtail.md'),
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

// --- Hooks (our named block inside agy's hooks.json) -----------------------

/** Read agy's `hooks.json` (a map of named blocks), or `{}` if absent/invalid. */
function readBlocks(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return {};
  try {
    return readJson<Record<string, unknown>>(hooksFile);
  } catch {
    return {};
  }
}

/** Install (or refresh) our `showtail` block, preserving any other user blocks. */
export function installAntigravityCliHooks(target: AntigravityCliTarget): string {
  mkdirSync(dirOf(target.hooksFile), { recursive: true });
  const blocks = readBlocks(target.hooksFile);
  blocks[ANTIGRAVITY_BLOCK_NAME] = antigravityCliBlock();
  writeJson(target.hooksFile, blocks);
  return target.hooksFile;
}

/** Remove only our `showtail` block (deletes the file if nothing else remains). */
export function uninstallAntigravityCliHooks(target: AntigravityCliTarget): boolean {
  if (!existsSync(target.hooksFile)) return false;
  const blocks = readBlocks(target.hooksFile);
  if (!(ANTIGRAVITY_BLOCK_NAME in blocks)) return false;
  delete blocks[ANTIGRAVITY_BLOCK_NAME];
  if (Object.keys(blocks).length === 0) {
    rmSync(target.hooksFile, { force: true });
  } else {
    writeJson(target.hooksFile, blocks);
  }
  return true;
}

/** Does this hooks.json contain our `showtail` auto-capture block? */
export function antigravityCliHooksInstalledAt(hooksFile: string): boolean {
  if (!existsSync(hooksFile)) return false;
  try {
    const blocks = readJson<Record<string, unknown>>(hooksFile);
    const block = blocks[ANTIGRAVITY_BLOCK_NAME];
    return Boolean(block && typeof block === 'object');
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
