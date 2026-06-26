/**
 * GitHub Copilot CLI — the `copilot` command (github-copilot-sdk). A live-capture
 * connect plugin, mirroring Codex/Gemini CLI: lifecycle hooks plus a custom
 * instructions file Showtail manages.
 *
 * Grounded in the real CLI (v1.0.64) and GitHub's docs:
 *  - `copilot help config` documents a `hooks` field "same schema as
 *    .github/hooks/*.json", keyed by event name, and a `disableAllHooks` toggle.
 *  - GitHub's hooks reference (docs.github.com/copilot/reference/hooks-reference)
 *    documents the file layout and event names used below.
 *
 * Where we write (DEDICATED Showtail paths — chosen so we never touch a file
 * another plugin manages: NOT AGENTS.md/codex, NOT
 * .github/copilot-instructions.md or .github/instructions/showtail.instructions.md
 * which the github-copilot VS Code plugin owns):
 *
 *  Hooks (Copilot CLI reads every *.json here):
 *   - user:    ~/.copilot/hooks/showtail.json
 *   - project: <root>/.github/hooks/showtail.json
 *  Instructions (Copilot reads any .github/instructions/<NAME>.instructions.md
 *  with `applyTo` frontmatter; user scope uses the parallel ~/.copilot tree):
 *   - user:    ~/.copilot/instructions/showtail-copilot-cli.instructions.md
 *   - project: <root>/.github/instructions/showtail-copilot-cli.instructions.md
 *
 * Hook file shape (per docs): { "version": 1, "hooks": { <Event>: [ ... ] } }.
 * We use the PascalCase (VS Code-compatible) event aliases the CLI accepts, which
 * line up with the HookEvents shape the rest of Showtail already uses.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect copilot-cli` is fully self-contained (no files to ship).
import COPILOT_BODY from '../../assets/copilot-cli/showtail.showtail.md' with { type: 'text' };
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

export { COPILOT_BODY };

export type InstallScope = 'user' | 'project';

/**
 * The canonical GitHub Copilot CLI hook configuration. Copilot's lifecycle
 * events map onto Showtail's the same way Codex/Gemini do:
 *  - SessionStart    → session-start
 *  - UserPromptSubmit → user-prompt (fires when the student submits a prompt)
 *  - PostToolUse     → post-edit  (matched to the file-writing tools)
 *  - Stop            → stop       (fires once the agent turn completes)
 * Every command is tagged `--tool copilot-cli` so events are attributed correctly.
 *
 * PostToolUse matches Copilot's edit tools. Copilot's built-in editing tools are
 * `write`/`edit` (str-replace style); the matcher is a regex anchored by the host
 * as ^(?:PATTERN)$ against the tool name.
 */
export const COPILOT_CLI_HOOK_EVENTS: HookEvents = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook session-start --tool copilot-cli' },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: 'showtail hook user-prompt --tool copilot-cli' },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'write|edit|str_replace_editor|create',
      hooks: [{ type: 'command', command: 'showtail hook post-edit --tool copilot-cli' }],
    },
  ],
  Stop: [
    { hooks: [{ type: 'command', command: 'showtail hook stop --tool copilot-cli' }] },
  ],
};

/**
 * The exact JSON text of a Copilot CLI hooks file with our hooks (for the
 * asset-sync test). Includes the `version: 1` envelope the CLI expects.
 */
export function copilotCliHooksJson(): string {
  return JSON.stringify({ version: 1, hooks: COPILOT_CLI_HOOK_EVENTS }, null, 2) + '\n';
}

export interface CopilotCliTarget {
  scope: InstallScope;
  /** Lifecycle hooks file Copilot CLI reads (user: ~/.copilot/hooks, project: .github/hooks). */
  hooksFile: string;
  /** Custom-instructions file (a dedicated .instructions.md Showtail owns). */
  instructionsFile: string;
}

/**
 * Resolve where to install for the given scope.
 *  - user:    ~/.copilot/hooks/showtail.json
 *             ~/.copilot/instructions/showtail-copilot-cli.instructions.md
 *  - project: <root>/.github/hooks/showtail.json
 *             <root>/.github/instructions/showtail-copilot-cli.instructions.md
 */
export function resolveCopilotCliTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): CopilotCliTarget {
  if (scope === 'user') {
    const copilotHome = join(homedir(), '.copilot');
    return {
      scope,
      hooksFile: join(copilotHome, 'hooks', 'showtail.json'),
      instructionsFile: join(
        copilotHome,
        'instructions',
        'showtail-copilot-cli.instructions.md',
      ),
    };
  }
  const base = findRoot(cwd) ?? cwd;
  const dotGithub = join(base, '.github');
  return {
    scope,
    hooksFile: join(dotGithub, 'hooks', 'showtail.json'),
    instructionsFile: join(
      dotGithub,
      'instructions',
      'showtail-copilot-cli.instructions.md',
    ),
  };
}

// --- Instructions (managed block in a dedicated .instructions.md) -----------

// Copilot's path-specific instruction files require an `applyTo` frontmatter
// directive (glob syntax); `**` applies to every file. It sits OUTSIDE the
// managed block as a small preamble (the body is what Showtail fingerprints).
const INSTRUCTIONS_PREAMBLE = "---\napplyTo: '**'\n---";

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/** Install or refresh the Showtail managed block in the Copilot instructions file. */
export function writeCopilotCliInstructions(
  target: CopilotCliTarget,
  options: WriteOptions = {},
): void {
  mkdirSync(dirOf(target.instructionsFile), { recursive: true });
  applyManagedBlock(
    target.instructionsFile,
    COPILOT_BODY,
    INSTRUCTIONS_PREAMBLE,
    options.force ?? false,
  );
}

export interface CopilotCliInstructionsState {
  installed: boolean;
  upToDate: boolean;
  userEdited: boolean;
  updateAvailable: boolean;
}

const ABSENT: CopilotCliInstructionsState = {
  installed: false,
  upToDate: false,
  userEdited: false,
  updateAvailable: false,
};

/** Inspect the instructions file's managed block and classify it for status/refresh. */
export function copilotCliInstructionsState(
  target: CopilotCliTarget,
): CopilotCliInstructionsState {
  if (!existsSync(target.instructionsFile)) return ABSENT;
  const parsed = parseBlock(readFileSync(target.instructionsFile, 'utf8'));
  if (!parsed) return ABSENT;
  const cls = classify(parsed, COPILOT_BODY);
  if (cls === 'edited') {
    return {
      installed: true,
      upToDate: false,
      userEdited: true,
      updateAvailable: parsed.sha !== shortHash(COPILOT_BODY),
    };
  }
  if (cls === 'stale') {
    return { installed: true, upToDate: false, userEdited: false, updateAvailable: true };
  }
  return { installed: true, upToDate: true, userEdited: false, updateAvailable: false };
}

/**
 * Remove the Showtail block from the instructions file. The file is a dedicated,
 * Showtail-created `.instructions.md` whose only non-block content is the
 * `applyTo` frontmatter we wrote to satisfy Copilot's path-specific format — so
 * if stripping our block leaves only that frontmatter (or nothing), delete the
 * whole file. Any *other* user content outside the block is preserved.
 */
export function removeCopilotCliInstructions(target: CopilotCliTarget): boolean {
  if (!existsSync(target.instructionsFile)) return false;
  const removed = stripManagedBlock(target.instructionsFile, () =>
    rmSync(target.instructionsFile, { force: true }),
  );
  if (!removed) return false;
  // If the remainder is just our own frontmatter preamble, drop the orphan file.
  if (
    existsSync(target.instructionsFile) &&
    readFileSync(target.instructionsFile, 'utf8').trim() === INSTRUCTIONS_PREAMBLE.trim()
  ) {
    rmSync(target.instructionsFile, { force: true });
  }
  return true;
}

// --- Hooks (.github/hooks/showtail.json | ~/.copilot/hooks/showtail.json) ----

/**
 * Read our hooks file as a settings-shaped object, always carrying the
 * `version: 1` envelope Copilot CLI expects (a fresh file gets it; an existing
 * one keeps whatever version it had).
 */
function readHooksFile(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return { version: 1 };
  try {
    const obj = readJson<Record<string, unknown>>(hooksFile);
    if (obj.version === undefined) obj.version = 1;
    return obj;
  } catch {
    return { version: 1 };
  }
}

/** Install (or refresh) the Copilot CLI hooks in the target's hooks file. */
export function installCopilotCliHooks(target: CopilotCliTarget): string {
  const merged = mergeHookEvents(
    readHooksFile(target.hooksFile),
    COPILOT_CLI_HOOK_EVENTS,
  );
  writeJson(target.hooksFile, merged);
  return target.hooksFile;
}

/** Remove the Copilot CLI hooks from the target's hooks file (if present). */
export function uninstallCopilotCliHooks(target: CopilotCliTarget): boolean {
  if (!existsSync(target.hooksFile)) return false;
  writeJson(target.hooksFile, unmergeHookEvents(readHooksFile(target.hooksFile)));
  return true;
}

/** Does this hooks file contain our auto-capture hooks? */
export function copilotCliHooksInstalledAt(hooksFile: string): boolean {
  if (!existsSync(hooksFile)) return false;
  try {
    return hasOurHooks(readJson<Record<string, unknown>>(hooksFile));
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's Copilot CLI hooks are active for work in `cwd` — true if
 * they're installed at either project or user scope.
 */
export function copilotCliAutoCaptureActive(cwd: string = process.cwd()): boolean {
  return (
    copilotCliHooksInstalledAt(resolveCopilotCliTarget('project', cwd).hooksFile) ||
    copilotCliHooksInstalledAt(resolveCopilotCliTarget('user', cwd).hooksFile)
  );
}
