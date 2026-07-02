import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect gemini-cli` is fully self-contained (no files to ship).
import GEMINI_BODY from '../../assets/gemini-cli/GEMINI.showtail.md' with { type: 'text' };
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

export { GEMINI_BODY };

export type InstallScope = 'user' | 'project';

/**
 * The canonical Gemini CLI hook configuration, written into `.gemini/settings.json`.
 * Gemini CLI's lifecycle events differ from Claude Code's, so the mapping is:
 *  - SessionStart → session-start
 *  - BeforeAgent  → user-prompt (fires after the user submits, before planning)
 *  - AfterTool    → post-edit   (matched to the file-writing tools)
 *  - AfterAgent   → stop        (fires once per turn after the final response)
 * Every command is tagged `--tool gemini-cli` so events are attributed correctly.
 */
export const GEMINI_CLI_HOOK_EVENTS: HookEvents = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook session-start --tool gemini-cli' },
      ],
    },
  ],
  BeforeAgent: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook user-prompt --tool gemini-cli' },
      ],
    },
  ],
  AfterTool: [
    {
      matcher: 'write_file|replace|edit',
      hooks: [{ type: 'command', command: 'showtail hook post-edit --tool gemini-cli' }],
    },
  ],
  AfterAgent: [
    { hooks: [{ type: 'command', command: 'showtail hook stop --tool gemini-cli' }] },
  ],
};

/** The exact JSON text of a `.gemini/settings.json` with our hooks (for asset-sync tests). */
export function geminiCliSettingsJson(): string {
  return JSON.stringify({ hooks: GEMINI_CLI_HOOK_EVENTS }, null, 2) + '\n';
}

export interface GeminiCliTarget {
  scope: InstallScope;
  /** The `.gemini` directory (user: ~/.gemini, project: <root>/.gemini). */
  geminiDir: string;
  /** Settings file Gemini CLI reads hooks from. */
  settingsFile: string;
  /** Context file (user: ~/.gemini/GEMINI.md, project: <root>/GEMINI.md). */
  contextFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user: ~/.gemini/{settings.json,GEMINI.md}
 *  - project: <root>/.gemini/settings.json and <root>/GEMINI.md
 */
export function resolveGeminiCliTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): GeminiCliTarget {
  const base = scope === 'user' ? homedir() : (findRoot(cwd) ?? cwd);
  const geminiDir = join(base, '.gemini');
  return {
    scope,
    geminiDir,
    settingsFile: join(geminiDir, 'settings.json'),
    contextFile:
      scope === 'user' ? join(geminiDir, 'GEMINI.md') : join(base, 'GEMINI.md'),
  };
}

// --- Instructions (managed block in GEMINI.md) -----------------------------

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/** Install or refresh the Showtail managed block in GEMINI.md. */
export function writeGeminiCliInstructions(
  target: GeminiCliTarget,
  options: WriteOptions = {},
): void {
  mkdirSync(dirOf(target.contextFile), { recursive: true });
  // GEMINI.md has no frontmatter, so the preamble is empty.
  applyManagedBlock(target.contextFile, GEMINI_BODY, '', options.force ?? false);
}

export interface GeminiCliInstructionsState {
  installed: boolean;
  upToDate: boolean;
  userEdited: boolean;
  updateAvailable: boolean;
}

const ABSENT: GeminiCliInstructionsState = {
  installed: false,
  upToDate: false,
  userEdited: false,
  updateAvailable: false,
};

/** Inspect the GEMINI.md managed block and classify it for status/refresh. */
export function geminiCliInstructionsState(
  target: GeminiCliTarget,
): GeminiCliInstructionsState {
  if (!existsSync(target.contextFile)) return ABSENT;
  const parsed = parseBlock(readFileSync(target.contextFile, 'utf8'));
  if (!parsed) return ABSENT;
  const cls = classify(parsed, GEMINI_BODY);
  if (cls === 'edited') {
    return {
      installed: true,
      upToDate: false,
      userEdited: true,
      updateAvailable: parsed.sha !== shortHash(GEMINI_BODY),
    };
  }
  if (cls === 'stale') {
    return { installed: true, upToDate: false, userEdited: false, updateAvailable: true };
  }
  return { installed: true, upToDate: true, userEdited: false, updateAvailable: false };
}

/** Remove the Showtail block from GEMINI.md (deletes the file if it empties). */
export function removeGeminiCliInstructions(target: GeminiCliTarget): boolean {
  return stripManagedBlock(target.contextFile, () =>
    rmSync(target.contextFile, { force: true }),
  );
}

// --- Hooks (.gemini/settings.json) -----------------------------------------

/** Read a `.gemini/settings.json` as a settings-shaped object, or `{}` if absent. */
function readSettings(settingsFile: string): Record<string, unknown> {
  if (!existsSync(settingsFile)) return {};
  try {
    return readJson<Record<string, unknown>>(settingsFile);
  } catch {
    return {};
  }
}

/** Install (or refresh) the Gemini CLI hooks in the target's settings.json. */
export function installGeminiCliHooks(target: GeminiCliTarget): string {
  const merged = mergeHookEvents(
    readSettings(target.settingsFile),
    GEMINI_CLI_HOOK_EVENTS,
  );
  writeJson(target.settingsFile, merged);
  return target.settingsFile;
}

/** Remove the Gemini CLI hooks from the target's settings.json (if present). */
export function uninstallGeminiCliHooks(target: GeminiCliTarget): boolean {
  if (!existsSync(target.settingsFile)) return false;
  writeJson(target.settingsFile, unmergeHookEvents(readSettings(target.settingsFile)));
  return true;
}

/** Does this settings.json contain our auto-capture hooks? */
export function geminiCliHooksInstalledAt(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  try {
    return hasOurHooks(readJson<Record<string, unknown>>(settingsFile));
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's Gemini CLI hooks are active for work in `cwd` — true if
 * they're installed at either project or user scope.
 */
export function geminiCliAutoCaptureActive(cwd: string = process.cwd()): boolean {
  return (
    geminiCliHooksInstalledAt(resolveGeminiCliTarget('project', cwd).settingsFile) ||
    geminiCliHooksInstalledAt(resolveGeminiCliTarget('user', cwd).settingsFile)
  );
}
