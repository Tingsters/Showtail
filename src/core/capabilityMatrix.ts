/**
 * The integration capability matrix — Showtail's single source of truth for
 * "what works where" across the AI coding tools students use.
 *
 * Every cell is one of four states:
 *   ✅ full        — implemented and verified end-to-end (live where possible).
 *   🚧 partial     — implemented with a known gap.
 *   🗺️ planned     — the tool exposes a surface for it, Showtail just hasn't built it.
 *   ⛔ unsupported  — the tool exposes no surface for it.
 *
 * The planned/unsupported split is *deterministic*, not a judgment call: it is
 * derived from each tool's {@link Surface} (does it expose hooks? an instructions
 * file? a readable transcript? a marketplace?). Only `full`/`partial` are
 * hand-authored, and only for tools Showtail actually has a plugin for — those
 * claims are then backed by tests (a `full` cell requires a passing test, and the
 * hook-capture ones require an LLM-driven live run; see tests/capability-*).
 *
 * The matrix lists every major vendor tool, including ones with no Showtail
 * plugin yet — those read as 🗺️ planned and double as the roadmap.
 */
import type { Tool } from '../types.ts';
import { getPluginById } from '../plugins/registry.ts';
import type { EnvironmentPlugin } from '../plugins/types.ts';

export type CapStatus = 'full' | 'partial' | 'planned' | 'unsupported';

/** What capture surfaces a tool exposes — the basis for planned vs unsupported. */
export interface Surface {
  /** A lifecycle-hook system that can run a command per event (auto capture). */
  hooks: boolean;
  /** A persistent instructions/rules/context file the tool reads. */
  instructions: boolean;
  /** A readable on-disk session transcript/log Showtail could import. */
  transcript: boolean;
  /** A plugin/extension gallery a Showtail installer could publish into. */
  marketplace: boolean;
  /** Runs locally (CLI/IDE/desktop) vs a hosted web app. */
  local: boolean;
  /** A plan/plan-mode the tool produces (a saved plan file or a transcript plan). */
  planFiles: boolean;
}

export interface Integration {
  /** Matrix column id (also the second half of a backing test id). */
  id: string;
  label: string;
  vendor: string;
  /** The Showtail plugin backing this tool, if one exists (links to the registry). */
  pluginId?: Tool;
  surface: Surface;
}

export interface Cell {
  status: CapStatus;
  /** Optional per-cell detail (surfaced in --json; the table uses the row note). */
  note?: string;
}

/** Derives a non-built cell's status from the tool's surface. Never returns full/partial. */
type SurfaceRule = (s: Surface) => 'planned' | 'unsupported';

export interface Capability {
  id: string;
  label: string;
  description: string;
  /** Concise row-level callout shown in the Notes column. */
  note?: string;
  /** Structural requirement a plugin must meet for a `full` claim to be legit. */
  requires?: (plugin: EnvironmentPlugin | undefined) => boolean;
  /** Hand-authored full/partial cells for built plugins, keyed by integration id. */
  overrides: Record<string, Cell>;
  /** Deterministic status for every other cell, from the tool's surface. */
  surfaceRule: SurfaceRule;
}

// --- integrations (columns) -------------------------------------------------

const surface = (
  hooks: boolean,
  instructions: boolean,
  transcript: boolean,
  marketplace: boolean,
  local: boolean,
  planFiles = false,
): Surface => ({ hooks, instructions, transcript, marketplace, local, planFiles });

/**
 * Columns, vendor-ordered. Surface flags reflect what each TOOL exposes (as of
 * 2026 research); `partial`/`unknown` surfaces are encoded `true` and flagged in
 * the relevant row note. `pluginId` is set only where Showtail has a plugin.
 */
export const INTEGRATIONS: Integration[] = [
  // Anthropic
  {
    id: 'claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    pluginId: 'claude-code',
    surface: surface(true, true, true, true, true, true),
  },
  // OpenAI
  {
    id: 'codex',
    label: 'OpenAI Codex',
    vendor: 'OpenAI',
    pluginId: 'codex',
    surface: surface(true, true, true, true, true, true),
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    vendor: 'OpenAI',
    pluginId: 'chatgpt',
    surface: surface(false, false, true, false, false),
  },
  // GitHub
  {
    id: 'copilot-vscode',
    label: 'Copilot (VS Code)',
    vendor: 'GitHub',
    pluginId: 'github-copilot',
    surface: surface(true, true, true, true, true),
  },
  {
    id: 'copilot-cli',
    label: 'Copilot CLI',
    vendor: 'GitHub',
    pluginId: 'copilot-cli',
    surface: surface(true, true, true, true, true),
  },
  {
    id: 'copilot-desktop',
    label: 'Copilot Desktop',
    vendor: 'GitHub',
    surface: surface(true, true, true, true, true),
  },
  // Google
  {
    id: 'antigravity-cli',
    label: 'Antigravity CLI',
    vendor: 'Google',
    pluginId: 'antigravity-cli',
    surface: surface(true, true, true, true, true, true),
  },
  {
    id: 'antigravity-ide',
    label: 'Antigravity IDE',
    vendor: 'Google',
    pluginId: 'antigravity-ide',
    surface: surface(true, true, true, true, true, true),
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini',
    vendor: 'Google',
    pluginId: 'google-gemini',
    surface: surface(false, false, true, false, false),
  },
  // Zed
  {
    id: 'zed',
    label: 'Zed',
    vendor: 'Zed',
    surface: surface(false, true, true, true, true),
  },
];

export const INTEGRATION_IDS: string[] = INTEGRATIONS.map((i) => i.id);

// --- structural predicates (read off the plugin contract) ------------------

const hasHooks = (p?: EnvironmentPlugin) => Boolean(p?.connect?.hooks);
const hasTranscript = (p?: EnvironmentPlugin) =>
  Boolean(p?.connect?.hooks?.getTranscript);
const hasImport = (p?: EnvironmentPlugin) => Boolean(p?.import);
const hasConnect = (p?: EnvironmentPlugin) => Boolean(p?.connect);

// --- surface rules (deterministic planned/unsupported) ---------------------

const needHooks: SurfaceRule = (s) => (s.hooks ? 'planned' : 'unsupported');
const needTranscript: SurfaceRule = (s) => (s.transcript ? 'planned' : 'unsupported');
const needReplyPath: SurfaceRule = (s) =>
  s.hooks && s.transcript ? 'planned' : 'unsupported';
const needInstructions: SurfaceRule = (s) => (s.instructions ? 'planned' : 'unsupported');
const needLocal: SurfaceRule = (s) => (s.local ? 'planned' : 'unsupported');
const needMarketplace: SurfaceRule = (s) => (s.marketplace ? 'planned' : 'unsupported');
const needEventPath: SurfaceRule = (s) =>
  s.hooks || s.instructions || s.transcript ? 'planned' : 'unsupported';
const needPlanFiles: SurfaceRule = (s) => (s.planFiles ? 'planned' : 'unsupported');

// --- cell constructors for overrides ---------------------------------------

const full = (note?: string): Cell => ({ status: 'full', note });
const partial = (note: string): Cell => ({ status: 'partial', note });

export const CAPABILITIES: Capability[] = [
  {
    id: 'live-capture-hooks',
    label: 'Live-capture hooks',
    description: 'Automatic capture wired into the tool’s lifecycle hooks.',
    note: 'Live-certified for Claude Code, Codex, and Antigravity CLI. Copilot CLI fires no lifecycle hooks in headless `-p` mode, so it can’t be live-certified here; Copilot (VS Code) uses its extension; Zed has no hooks.',
    requires: hasHooks,
    surfaceRule: needHooks,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': partial(
        'Hooks wired + contract-tested, but Copilot CLI fires no lifecycle hooks in headless `-p` mode (verified with a valid token at user + project scope), so live capture can’t be certified by the headless harness.',
      ),
      'antigravity-cli': full(),
      'antigravity-ide': partial(
        'Hooks wired to the IDE’s global ~/.gemini/config/hooks.json + contract-tested; not certified live (the IDE can’t be driven headlessly here).',
      ),
      'copilot-vscode': partial(
        'Captured by the VS Code extension on save, not via lifecycle hooks.',
      ),
    },
  },
  {
    id: 'auto-prompt-capture',
    label: 'Auto prompt capture',
    description: 'Your prompts are recorded automatically as you submit them.',
    note: 'Live-certified for Claude Code + Codex; the CLI plugins are built but their live capture isn’t certified here. Copilot (VS Code) is model-driven.',
    requires: hasHooks,
    surfaceRule: needHooks,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': partial(
        'Hooks wired + contract-tested, but Copilot CLI fires no hooks in headless `-p` mode (verified with a token), so prompt capture can’t be certified here.',
      ),
      'antigravity-cli': partial(
        'agy fires its prompt hook (PreInvocation) in interactive sessions; headless `agy -p` only fires PostToolUse, so prompt capture isn’t certified here.',
      ),
      'antigravity-ide': partial(
        'Hooks wired + contract-tested; live capture not certified (the IDE can’t be driven headlessly here).',
      ),
      'copilot-vscode': partial('Model-driven via instructions — not guaranteed.'),
    },
  },
  {
    id: 'auto-file-capture',
    label: 'Auto file/edit capture',
    description: 'Files the tool edits are snapshotted as artifacts automatically.',
    note: 'Live-certified for Claude Code + Antigravity CLI. Codex live apply_patch isn’t snapshotted headlessly; Copilot CLI fires no hooks in headless mode; Copilot (VS Code) snapshots on save with no AI diff.',
    requires: hasHooks,
    surfaceRule: needHooks,
    overrides: {
      'claude-code': full(),
      codex: partial(
        'Contract-tested, but a live apply_patch edit was not snapshotted in headless Codex runs on this machine.',
      ),
      'copilot-cli': partial(
        'Hooks wired + contract-tested, but Copilot CLI fires no hooks in headless `-p` mode (verified with a token), so file capture can’t be certified here.',
      ),
      'antigravity-cli': full(),
      'antigravity-ide': partial(
        'Hooks wired + contract-tested; live capture not certified (the IDE can’t be driven headlessly here).',
      ),
      'copilot-vscode': partial(
        'The extension snapshots on save; no AI-suggested diff and non-VS-Code edits are missed.',
      ),
    },
  },
  {
    id: 'auto-ai-output-capture',
    label: 'Auto AI-reply capture',
    description:
      'AI replies are captured and reconciled from the session transcript at stop.',
    note: 'Needs the tool’s stop-hook plus a readable transcript; planned wherever both exist.',
    requires: hasTranscript,
    surfaceRule: needReplyPath,
    overrides: {
      'claude-code': full(),
      codex: full(),
    },
  },
  {
    id: 'decision-capture',
    label: 'Decision capture',
    description:
      'Choices you make when the AI pauses to ask (AskUserQuestion-style) are captured as decisions.',
    note: 'Reconciled from the tool’s transcript on the Stop hook, so — like AI-reply capture — it is certified by its contract test, not the headless live run. Planned wherever a tool has hooks + a transcript but no ask-the-user construct yet.',
    requires: hasTranscript,
    surfaceRule: needReplyPath,
    overrides: {
      'claude-code': full(),
      codex: full(),
      // antigravity-cli / copilot-cli → derived 'planned' (no decision construct yet).
    },
  },
  {
    id: 'plan-capture',
    label: 'Plan capture',
    description:
      'Plans the AI proposes are captured as a first-class item, with a saved, linkable plan file.',
    note: 'Full for Claude Code + Antigravity CLI (Antigravity links its real plan.md). Codex captures plan content from the transcript (no native file). Antigravity IDE writes implementation_plan.md but has no plugin yet. Reconciled on the Stop hook, so — like AI-reply capture — it is certified by its contract test, not the headless live run (print mode never raises Stop).',
    // A plan rides in on the same stop transcript path, so a real claim needs one.
    requires: hasTranscript,
    surfaceRule: needPlanFiles,
    overrides: {
      'claude-code': full(),
      'antigravity-cli': full(),
      codex: partial(
        'Plan content captured + materialized from the transcript; Codex writes no native plan file.',
      ),
      // antigravity-ide → derived 'planned' (planFiles surface, no plugin yet).
    },
  },
  {
    id: 'session-import',
    label: 'Session import / backfill',
    description:
      'Pull an existing conversation (share link, saved page, or transcript) into the trail.',
    note: 'Planned wherever the tool writes a readable transcript (Zed: only via manual Markdown export).',
    requires: hasImport,
    surfaceRule: needTranscript,
    overrides: {
      'claude-code': full(),
      codex: full(),
      chatgpt: full(),
      'google-gemini': full(),
      'antigravity-ide': full(),
    },
  },
  {
    id: 'managed-instructions',
    label: 'Managed instructions',
    description: 'Installs and maintains Showtail instructions/skill inside the tool.',
    note: 'Planned wherever the tool reads an instructions/rules file.',
    requires: hasConnect,
    surfaceRule: needInstructions,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
    },
  },
  {
    id: 'update-detection',
    label: 'Instruction update detection',
    description:
      'Detects stale or user-edited managed instructions and offers to refresh them.',
    note: 'Detected via a managed-block fingerprint in each tool’s instructions/skill file.',
    surfaceRule: needInstructions,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
    },
  },
  {
    id: 'multi-scope-install',
    label: 'User + project install',
    description: 'Connect per-user (all projects) or per-project.',
    note: 'Copilot (VS Code) is project-scoped only (.github/).',
    surfaceRule: needInstructions,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': partial(
        'Instructions install per-user or per-project; capture hooks are global-only (the IDE loads only ~/.gemini/config/hooks.json).',
      ),
      'copilot-vscode': partial('Project-scoped only (.github/); no user-scope install.'),
    },
  },
  {
    id: 'host-detection',
    label: 'Host detection (setup)',
    description:
      '`showtail setup` detects the tool on this machine and connects/guides accordingly.',
    note: 'Hosted web apps have nothing local to detect.',
    requires: hasConnect,
    surfaceRule: needLocal,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
    },
  },
  {
    id: 'status-detection',
    label: 'Connection status',
    description: '`showtail status` reports whether the tool is connected and capturing.',
    note: 'Needs a local footprint to inspect; web apps have none.',
    requires: hasConnect,
    surfaceRule: needLocal,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
    },
  },
  {
    id: 'redaction',
    label: 'Secret/PII redaction',
    description: 'Secrets and personal data are scrubbed before anything is stored.',
    note: 'Applies automatically once any capture or import path for the tool exists.',
    surfaceRule: needEventPath,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
      chatgpt: full(),
      'google-gemini': full(),
    },
  },
  {
    id: 'cross-tool-timeline',
    label: 'Cross-tool timeline',
    description:
      'Events from this tool appear, tagged, on the one unified report timeline.',
    note: 'Any captured or imported event from the tool joins the shared timeline.',
    surfaceRule: needEventPath,
    overrides: {
      'claude-code': full(),
      codex: full(),
      'copilot-cli': full(),
      'antigravity-cli': full(),
      'antigravity-ide': full(),
      'copilot-vscode': full(),
      chatgpt: full(),
      'google-gemini': full(),
    },
  },
  {
    id: 'marketplace-install',
    label: 'Marketplace/extension install',
    description: 'One-command install from a plugin marketplace or extension gallery.',
    note: 'Codex/Copilot CLI/Antigravity expose a marketplace; a Showtail installer just isn’t published there yet.',
    surfaceRule: needMarketplace,
    overrides: {
      'claude-code': full(),
      'copilot-vscode': full(),
    },
  },
];

// --- resolution -------------------------------------------------------------

/** The status cell for one capability × integration (override, else derived). */
export function cellFor(cap: Capability, integration: Integration): Cell {
  return (
    cap.overrides[integration.id] ?? { status: cap.surfaceRule(integration.surface) }
  );
}

// --- backing-test convention -----------------------------------------------

export function testIdFor(capabilityId: string, integrationId: string): string {
  return `${capabilityId}:${integrationId}`;
}

/**
 * Capabilities whose `full` claim must be certified by an LLM-driven live run
 * (Tier B) — the edit-driven hook-capture capabilities. `auto-ai-output-capture`
 * is excluded: it fires on the host Stop hook, which headless print mode never
 * raises, so it stands on its contract E2E. Import/redaction/timeline are
 * certified by contract tests against real recorded payloads.
 */
export const LIVE_CERTIFIED_CAPABILITIES = new Set([
  'live-capture-hooks',
  'auto-prompt-capture',
  'auto-file-capture',
]);

/** Every `full` cell, as `{ capabilityId, integration, testId, liveRequired }`. */
export function fullClaims(): Array<{
  capabilityId: string;
  integration: string;
  testId: string;
  liveRequired: boolean;
}> {
  const out: Array<{
    capabilityId: string;
    integration: string;
    testId: string;
    liveRequired: boolean;
  }> = [];
  for (const cap of CAPABILITIES) {
    for (const integ of INTEGRATIONS) {
      if (cellFor(cap, integ).status !== 'full') continue;
      out.push({
        capabilityId: cap.id,
        integration: integ.id,
        testId: testIdFor(cap.id, integ.id),
        liveRequired: LIVE_CERTIFIED_CAPABILITIES.has(cap.id),
      });
    }
  }
  return out;
}

/** A `full` cell must satisfy the capability's structural requirement on its plugin. */
export function fullClaimIsStructural(
  cap: Capability,
  integration: Integration,
): boolean {
  if (!cap.requires) return true;
  return cap.requires(
    integration.pluginId ? getPluginById(integration.pluginId) : undefined,
  );
}

// --- rendering --------------------------------------------------------------

export const STATUS_EMOJI: Record<CapStatus, string> = {
  full: '✅',
  partial: '🚧',
  planned: '🗺️',
  unsupported: '⛔',
};

export const STATUS_LABEL: Record<CapStatus, string> = {
  full: 'Full',
  partial: 'Partial',
  planned: 'Planned',
  unsupported: 'Unsupported',
};

export interface MatrixRow {
  capability: Capability;
  cells: Array<{ integration: string; cell: Cell }>;
}

export function matrixRows(): MatrixRow[] {
  return CAPABILITIES.map((capability) => ({
    capability,
    cells: INTEGRATIONS.map((integration) => ({
      integration: integration.id,
      cell: cellFor(capability, integration),
    })),
  }));
}

/** Plain, serializable view for `--json` (statuses + per-cell notes, no functions). */
export function matrixJson(): {
  integrations: Array<{ id: string; label: string; vendor: string; hasPlugin: boolean }>;
  capabilities: Array<{
    id: string;
    label: string;
    description: string;
    note?: string;
    cells: Record<string, Cell>;
  }>;
} {
  return {
    integrations: INTEGRATIONS.map((i) => ({
      id: i.id,
      label: i.label,
      vendor: i.vendor,
      hasPlugin: Boolean(i.pluginId),
    })),
    capabilities: CAPABILITIES.map((cap) => {
      const cells: Record<string, Cell> = {};
      for (const integ of INTEGRATIONS) cells[integ.id] = cellFor(cap, integ);
      return {
        id: cap.id,
        label: cap.label,
        description: cap.description,
        note: cap.note,
        cells,
      };
    }),
  };
}

/**
 * Render the matrix as a GitHub-flavored Markdown table: one emoji-only column
 * per integration, a Notes column on the right, and a legend below. No footnotes.
 */
export function renderMatrixMarkdown(): string {
  const header = ['Capability', ...INTEGRATIONS.map((i) => i.label), 'Notes'];
  const divider = header.map((_, i) =>
    i === 0 || i === header.length - 1 ? '---' : ':-:',
  );

  const rows = CAPABILITIES.map((cap) => {
    const cells = INTEGRATIONS.map((integ) => STATUS_EMOJI[cellFor(cap, integ).status]);
    return [`**${cap.label}**`, ...cells, cap.note ?? ''];
  });

  const toLine = (arr: string[]) => `| ${arr.join(' | ')} |`;
  const legend = (Object.keys(STATUS_EMOJI) as CapStatus[]).map(
    (s) => `${STATUS_EMOJI[s]} ${STATUS_LABEL[s]}`,
  );

  return [
    toLine(header),
    toLine(divider),
    ...rows.map(toLine),
    '',
    `**Key:** ${legend.join(' · ')}`,
    '',
    '✅ works end-to-end (verified) · 🚧 implemented with a gap · 🗺️ the tool supports it, ' +
      'not built yet · ⛔ the tool exposes no surface for it.',
  ].join('\n');
}
