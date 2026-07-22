import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary,
// so `showtail connect antigravity-ide` is fully self-contained (no files to ship).
import AGY_IDE_BODY from '../../assets/antigravity-ide/AGY-IDE.showtail.md' with { type: 'text' };
import { geminiHome } from './antigravityCliTranscript.ts';
import type { HookEvents } from './hookMerge.ts';
import { hasNamedHooks, mergeNamedHooks, unmergeNamedHooks } from './namedHooks.ts';
import {
  applyManagedBlock,
  classify,
  parseBlock,
  shortHash,
  stripManagedBlock,
} from './managedBlock.ts';
import { findRoot, readJson, writeJson } from './storage.ts';
import { dirOf } from './text.ts';

export { AGY_IDE_BODY };

export type InstallScope = 'user' | 'project';

// --- WHERE THE IDE READS HOOKS ----------------------------------------------
// Google's Antigravity IDE (a VS Code fork) loads hooks through its Go language
// server, which reads ONE global file at startup: `~/.gemini/config/hooks.json`
// (verified from the LS logs: discovery.go/hooks.go load that exact path). It is
// a *named-hooks* file — `{ "<name>": { enabled, <Event>: [...] } }` — NOT the
// `{ hooks: {...} }` map the Antigravity *CLI* writes to its own `.agents/` /
// `~/.gemini/antigravity-cli/` files. So this plugin:
//   * writes hooks ONLY to the global `~/.gemini/config/hooks.json`, under our
//     own `showtail` named bundle (see src/core/namedHooks.ts), leaving any other
//     bundle untouched. There is no per-workspace hook path the IDE reads.
//   * writes instructions to a dedicated, uniquely-named rules file
//     `AGY-IDE.showtail.md` — under the workspace `.agents/` dir (project) or
//     `~/.gemini/antigravity-ide/` (user) — never GEMINI.md / AGENTS.md / the
//     CLI's AGY.showtail.md.
// The IDE reads hooks.json only at language-server startup (no file watcher), so
// connecting requires an IDE restart to take effect.

/**
 * Our named bundle key inside the IDE's `~/.gemini/config/hooks.json`. Distinct
 * from the Antigravity CLI's `showtail-cli` key in the SAME shared file, so the
 * two tools' bundles coexist and neither's disconnect deletes the other's.
 */
export const ANTIGRAVITY_IDE_HOOK_NAMESPACE = 'showtail-ide';

/**
 * The canonical Antigravity IDE hook events, written under our named bundle.
 *
 * The IDE's language server (`jsonhook.go`) recognizes ONLY these lifecycle
 * events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`
 * (confirmed from the IDE's hook-editor source + the LS load log). This is NOT
 * the Claude/Codex set — an unknown event key (e.g. `SessionStart`) makes the Go
 * parser reject the whole file ("0 named hooks, 0 total handlers"). Each entry is
 * `{ matcher, hooks: [{ type:'command', command, timeout }] }` and the `matcher`
 * is a tool-name glob (`*` = all tools), not a regex. So the mapping is:
 *  - PreInvocation → user-prompt (fires before the model is called — turn start)
 *  - PostToolUse   → post-edit   (all tools; Showtail snapshots only file edits)
 *  - Stop          → stop        (reconciles prompts/replies/plans from the transcript)
 * Prompts are also recovered at Stop from the transcript, so capture is robust
 * even if PreInvocation carries no prompt text. Every command is tagged
 * `--tool antigravity-ide` for correct attribution.
 */
const HOOK_TIMEOUT_SECONDS = 30;
export const ANTIGRAVITY_IDE_HOOK_EVENTS: HookEvents = {
  // No `matcher` on PreInvocation/Stop: `matcher` is a TOOL-NAME filter, and these
  // are not tool events — including one made the IDE skip them (only PostToolUse,
  // which has real tool calls to match, fired). Matcher stays on PostToolUse only.
  PreInvocation: [
    {
      hooks: [
        {
          type: 'command',
          command: 'showtail hook user-prompt --tool antigravity-ide',
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: 'showtail hook post-edit --tool antigravity-ide',
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'command',
          command: 'showtail hook stop --tool antigravity-ide',
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ],
};

/** The exact JSON text of the IDE's named-bundle hooks block (for asset-sync tests). */
export function antigravityIdeHooksJson(): string {
  return (
    JSON.stringify(
      mergeNamedHooks({}, ANTIGRAVITY_IDE_HOOK_NAMESPACE, ANTIGRAVITY_IDE_HOOK_EVENTS),
      null,
      2,
    ) + '\n'
  );
}

export interface AntigravityIdeTarget {
  scope: InstallScope;
  /** Dir holding our instructions file (workspace `.agents/` or `~/.gemini/antigravity-ide`). */
  configDir: string;
  /**
   * The GLOBAL hooks file the IDE loads — `~/.gemini/config/hooks.json`. The same
   * for every scope: the IDE has no per-workspace hook path.
   */
  hooksFile: string;
  /** Dedicated, uniquely-named rules/instructions file (never GEMINI.md/AGENTS.md). */
  contextFile: string;
}

/**
 * Is Google's Antigravity IDE installed on this host? Keys on the IDE's OWN
 * product directory `<geminiHome>/antigravity-ide` (where it stores per-conversation
 * brains) — NOT the shared `~/.gemini` root, which the Antigravity *CLI* also
 * creates. Detecting on the shared root made the IDE falsely register as installed
 * after a CLI-only connect, so a second `showtail setup` would spuriously connect it.
 */
export function antigravityIdeInstalledOnHost(): boolean {
  return existsSync(join(geminiHome(), 'antigravity-ide'));
}

/**
 * Resolve where to install for the given scope. Hooks always target the global
 * `~/.gemini/config/hooks.json` (the only path the IDE reads); only the
 * instructions file location varies by scope:
 *  - user: ~/.gemini/antigravity-ide/AGY-IDE.showtail.md
 *  - project: <root>/.agents/AGY-IDE.showtail.md
 */
export function resolveAntigravityIdeTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): AntigravityIdeTarget {
  const configDir =
    scope === 'user'
      ? join(geminiHome(), 'antigravity-ide')
      : join(findRoot(cwd) ?? cwd, '.agents');
  return {
    scope,
    configDir,
    hooksFile: join(geminiHome(), 'config', 'hooks.json'),
    contextFile: join(configDir, 'AGY-IDE.showtail.md'),
  };
}

// --- Instructions (managed block in AGY-IDE.showtail.md) -------------------

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/** Install or refresh the Showtail managed block in the instructions file. */
export function writeAntigravityIdeInstructions(
  target: AntigravityIdeTarget,
  options: WriteOptions = {},
): void {
  mkdirSync(dirOf(target.contextFile), { recursive: true });
  // The instructions file has no frontmatter, so the preamble is empty.
  applyManagedBlock(target.contextFile, AGY_IDE_BODY, '', options.force ?? false);
}

export interface AntigravityIdeInstructionsState {
  installed: boolean;
  upToDate: boolean;
  userEdited: boolean;
  updateAvailable: boolean;
}

const ABSENT: AntigravityIdeInstructionsState = {
  installed: false,
  upToDate: false,
  userEdited: false,
  updateAvailable: false,
};

/** Inspect the instructions managed block and classify it for status/refresh. */
export function antigravityIdeInstructionsState(
  target: AntigravityIdeTarget,
): AntigravityIdeInstructionsState {
  if (!existsSync(target.contextFile)) return ABSENT;
  const parsed = parseBlock(readFileSync(target.contextFile, 'utf8'));
  if (!parsed) return ABSENT;
  const cls = classify(parsed, AGY_IDE_BODY);
  if (cls === 'edited') {
    return {
      installed: true,
      upToDate: false,
      userEdited: true,
      updateAvailable: parsed.sha !== shortHash(AGY_IDE_BODY),
    };
  }
  if (cls === 'stale') {
    return { installed: true, upToDate: false, userEdited: false, updateAvailable: true };
  }
  return { installed: true, upToDate: true, userEdited: false, updateAvailable: false };
}

/** Remove the Showtail block from the instructions file (deletes it if it empties). */
export function removeAntigravityIdeInstructions(target: AntigravityIdeTarget): boolean {
  return stripManagedBlock(target.contextFile, () =>
    rmSync(target.contextFile, { force: true }),
  );
}

// --- Hooks (named bundle in ~/.gemini/config/hooks.json) -------------------

/** Read a `hooks.json` as a named-bundle object, or `{}` if absent/unreadable. */
function readHooksFile(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return {};
  try {
    return readJson<Record<string, unknown>>(hooksFile);
  } catch {
    return {};
  }
}

/** Install (or refresh) our named hook bundle in the IDE's global hooks.json. */
export function installAntigravityIdeHooks(target: AntigravityIdeTarget): string {
  const merged = mergeNamedHooks(
    readHooksFile(target.hooksFile),
    ANTIGRAVITY_IDE_HOOK_NAMESPACE,
    ANTIGRAVITY_IDE_HOOK_EVENTS,
  );
  writeJson(target.hooksFile, merged);
  return target.hooksFile;
}

/** Remove our named hook bundle from the IDE's global hooks.json (if present). */
export function uninstallAntigravityIdeHooks(target: AntigravityIdeTarget): boolean {
  if (!existsSync(target.hooksFile)) return false;
  if (!antigravityIdeHooksInstalledAt(target.hooksFile)) return false;
  writeJson(
    target.hooksFile,
    unmergeNamedHooks(readHooksFile(target.hooksFile), ANTIGRAVITY_IDE_HOOK_NAMESPACE),
  );
  return true;
}

/** Does this hooks.json contain our auto-capture named bundle? */
export function antigravityIdeHooksInstalledAt(hooksFile: string): boolean {
  if (!existsSync(hooksFile)) return false;
  try {
    return hasNamedHooks(
      readJson<Record<string, unknown>>(hooksFile),
      ANTIGRAVITY_IDE_HOOK_NAMESPACE,
    );
  } catch {
    return false;
  }
}

/**
 * Whether Showtail's Antigravity IDE hooks are active. The IDE reads only the
 * global hooks file, so scope is irrelevant — `cwd` is accepted for signature
 * parity with the other plugins' status readers.
 */
export function antigravityIdeAutoCaptureActive(cwd: string = process.cwd()): boolean {
  return antigravityIdeHooksInstalledAt(
    resolveAntigravityIdeTarget('user', cwd).hooksFile,
  );
}
