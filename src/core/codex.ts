import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  removeReportSkill,
  reportSkillState,
  retireInstructions,
  writeReportSkill,
} from './reportDiscovery.ts';
import { REPORT_SKILL as AGENTS_BODY } from './reportDiscovery.ts';
import {
  hasOurHooks,
  mergeHookEvents,
  unmergeHookEvents,
  type HookEvents,
} from './hookMerge.ts';
import { hostHome } from './hostHome.ts';
import { findRoot, readJson, writeJson } from './storage.ts';
import { dirOf } from './text.ts';

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
  PostToolUse: [
    {
      // Current Codex normalizes shell commands and unified exec to `Bash`.
      // Older hosts emitted `shell_command`; retain that alias as well as the
      // structured patch tool. Match whole names so unrelated tools do not
      // trigger file observations.
      matcher: '^(apply_patch|shell_command|Bash)$',
      hooks: [
        { type: 'command', command: 'showtail hook post-edit --tool codex', async: true },
      ],
    },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'showtail hook stop --tool codex' }] }],
};

/** The exact JSON text of a `.codex/hooks.json` (for the asset-sync test). */
export function codexHooksJson(): string {
  return JSON.stringify({ hooks: CODEX_HOOK_EVENTS }, null, 2) + '\n';
}

export const CODEX_HOOK_TRUST_GUIDANCE =
  'Open /hooks in Codex to review and trust the Showtail callbacks. Until then, use showtail sync to collect saved native history.';

/** Interpret Codex's documented hooks/list result; never grant trust ourselves. */
export function codexHookHealth(result: unknown): {
  hooksActive: boolean;
  issues: { code: string; message: string }[];
} {
  const rows = (result as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows) || rows.length !== 1) return codexHookHealthUnavailable();
  const row = rows[0] as { hooks?: unknown[]; errors?: unknown[] } | null;
  if (!Array.isArray(row?.hooks)) return codexHookHealthUnavailable();
  if (Array.isArray(row.errors) && row.errors.length) {
    return {
      hooksActive: false,
      issues: [
        {
          code: 'HOOK_CONFIG_INVALID',
          message: 'Codex could not load its hook configuration. Review /hooks in Codex.',
        },
      ],
    };
  }
  const hooks = row.hooks.filter(
    (hook): hook is Record<string, unknown> =>
      !!hook &&
      typeof hook === 'object' &&
      (hook as Record<string, unknown>).handlerType === 'command' &&
      typeof (hook as Record<string, unknown>).command === 'string' &&
      (hook as { command: string }).command.includes('showtail hook') &&
      /--tool\s+codex(?:\s|$)/.test((hook as { command: string }).command),
  );
  const required = ['sessionStart', 'postToolUse', 'stop'];
  if (!required.every((event) => hooks.some((hook) => hook.eventName === event))) {
    return {
      hooksActive: false,
      issues: [
        {
          code: 'HOOKS_NOT_LOADED',
          message:
            'Codex did not load all Showtail callbacks. Reconnect Codex and review /hooks.',
        },
      ],
    };
  }
  if (hooks.some((hook) => hook.enabled !== true)) {
    return {
      hooksActive: false,
      issues: [
        {
          code: 'HOOKS_DISABLED',
          message: 'Enable the Showtail callbacks in Codex /hooks.',
        },
      ],
    };
  }
  if (hooks.some((hook) => !['trusted', 'managed'].includes(String(hook.trustStatus)))) {
    return {
      hooksActive: false,
      issues: [{ code: 'HOOK_TRUST_REQUIRED', message: CODEX_HOOK_TRUST_GUIDANCE }],
    };
  }
  return { hooksActive: true, issues: [] };
}

export function codexHookHealthUnavailable() {
  return {
    hooksActive: false,
    issues: [
      {
        code: 'HOOK_STATE_UNAVAILABLE',
        message:
          'Codex hook state could not be verified. Review /hooks in Codex; saved history remains available through showtail sync.',
      },
    ],
  };
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
  /** Old user-scope location, removed only when its Showtail block is unedited. */
  legacyAgentsFile?: string;
}

/**
 * Earlier installs could leave user-wide instructions in `~/AGENTS.md`. A
 * relocated CODEX_HOME does not identify the user's HOME unless it still names
 * a `.codex` directory, so skip cleanup rather than guessing a broad path.
 */
function legacyUserAgentsFile(): string | undefined {
  const override = process.env.CODEX_HOME;
  if (!override) return join(homedir(), 'AGENTS.md');
  const codexDir = resolve(override);
  return basename(codexDir).toLowerCase() === '.codex'
    ? join(dirname(codexDir), 'AGENTS.md')
    : undefined;
}

/**
 * Resolve where to install for the given scope.
 *  - user: ~/.codex/{hooks.json,config.toml,AGENTS.md} (`CODEX_HOME` relocates it)
 *  - project: <root>/.codex/{hooks.json,config.toml} and <root>/AGENTS.md
 */
export function resolveCodexTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): CodexTarget {
  const user = scope === 'user';
  // User scope: the override names `.codex` itself, so there is no home to join
  // onto (project scope still hangs everything off the repo root).
  const root = user ? '' : (findRoot(cwd) ?? cwd);
  const codexDir = user ? hostHome('CODEX_HOME', '.codex') : join(root, '.codex');
  return {
    scope,
    codexDir,
    hooksFile: join(codexDir, 'hooks.json'),
    configToml: join(codexDir, 'config.toml'),
    agentsFile: user ? join(codexDir, 'AGENTS.md') : join(root, 'AGENTS.md'),
    legacyAgentsFile: user ? legacyUserAgentsFile() : undefined,
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
  writeReportSkill(
    'codex',
    [target.agentsFile, ...(target.legacyAgentsFile ? [target.legacyAgentsFile] : [])],
    options.force,
  );
}
export function codexInstructionsState(_target: CodexTarget) {
  return reportSkillState('codex');
}
export function removeCodexInstructions(target: CodexTarget): boolean {
  const retired = retireInstructions(target.agentsFile);
  return removeReportSkill('codex') || retired;
}

// --- Hooks (.codex/hooks.json) ---------------------------------------------

/** Read a `.codex/hooks.json` as a settings-shaped object, or `{}` if absent. */
function readHooksFile(hooksFile: string): Record<string, unknown> {
  if (!existsSync(hooksFile)) return {};
  try {
    return readJson<Record<string, unknown>>(hooksFile);
  } catch {
    throw new Error(
      'HOOK_CONFIG_INVALID: repair the existing hook configuration before reconnecting.',
    );
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
    mkdirSync(dirOf(configToml), { recursive: true });
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
