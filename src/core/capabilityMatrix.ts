/**
 * The integration capability matrix — Showtail's single source of truth for
 * "what works where". Every AI coding environment Showtail integrates with
 * supports a different subset of capabilities; this module declares, for each
 * (capability × integration) cell, whether it is fully implemented, partially
 * implemented, planned, or not planned (impossible given that integration's
 * constraints) — with a note explaining every non-full cell.
 *
 * Two properties keep the matrix honest:
 *  1. It is cross-checked against the plugin registry (src/plugins): a cell may
 *     only claim `full` for a hook-based capability if the plugin actually
 *     declares the matching machinery (a hooks adapter, a transcript reader,
 *     both install scopes, an importer…). See {@link fullClaimIsStructural}.
 *  2. Every `full` cell must be backed by a passing end-to-end test, keyed
 *     `${capabilityId}:${integrationId}` (see tests/e2eRegistry.ts). A `full`
 *     claim with no passing test fails CI.
 *
 * The renderer at the bottom turns this data into the Markdown table injected
 * into README.md (kept in sync by a drift test) and printed by `showtail matrix`.
 */
import type { Tool } from '../types.ts';
import { PLUGINS, getPluginById, labelForTool } from '../plugins/registry.ts';
import type { EnvironmentPlugin } from '../plugins/types.ts';

/** A column in the matrix: a plugin id, or the manual `cli`. */
export type IntegrationId = Tool;

/** Implementation status of one capability for one integration. */
export type CapStatus = 'full' | 'partial' | 'planned' | 'not-planned';

export interface Cell {
  status: CapStatus;
  /** Required for partial/planned/not-planned: what's missing or why impossible. */
  note?: string;
}

export interface Capability {
  /** Stable id; combined with an integration id to key its backing test. */
  id: string;
  /** Short column-friendly label. */
  label: string;
  /** One-line description of the capability. */
  description: string;
  /**
   * Structural requirement a plugin must satisfy for this capability's `full`
   * claim to be legitimate. `undefined` means the capability is tool-agnostic
   * (e.g. redaction) and any cell may claim `full`. Receives the plugin for the
   * cell's integration (undefined for `cli`).
   */
  requires?: (plugin: EnvironmentPlugin | undefined) => boolean;
  cells: Record<IntegrationId, Cell>;
}

/**
 * Column order: every connect/import plugin in registry order, then the manual
 * CLI. Derived from the registry so a new plugin appears automatically and the
 * columns can never drift from the real integration set.
 */
export const INTEGRATION_IDS: IntegrationId[] = [...PLUGINS.map((p) => p.id), 'cli'];

// --- structural predicates (read straight off the plugin contract) ---------

const hasHooks = (p?: EnvironmentPlugin) => Boolean(p?.connect?.hooks);
const hasTranscript = (p?: EnvironmentPlugin) =>
  Boolean(p?.connect?.hooks?.getTranscript);
const hasImport = (p?: EnvironmentPlugin) => Boolean(p?.import);
const hasConnect = (p?: EnvironmentPlugin) => Boolean(p?.connect);
const hasBothScopes = (p?: EnvironmentPlugin) =>
  Boolean(p?.connect?.scopes.includes('user') && p?.connect?.scopes.includes('project'));

// --- cell constructors (keep the table below terse and uniform) ------------

const full = (): Cell => ({ status: 'full' });
const partial = (note: string): Cell => ({ status: 'partial', note });
const planned = (note: string): Cell => ({ status: 'planned', note });
const no = (note: string): Cell => ({ status: 'not-planned', note });

/** Build a cells record from a partial map, defaulting omitted columns. */
function cells(
  map: Partial<Record<IntegrationId, Cell>>,
  fallback: (id: IntegrationId) => Cell,
): Record<IntegrationId, Cell> {
  const out = {} as Record<IntegrationId, Cell>;
  for (const id of INTEGRATION_IDS) out[id] = map[id] ?? fallback(id);
  return out;
}

const NA_IMPORT = 'No live-capture surface; this integration is import-only.';
const NA_HOST = 'Hosted web app — nothing runs locally for Showtail to hook into.';
const NA_MANUAL =
  'CLI is the manual fallback; events are logged explicitly, not captured.';

export const CAPABILITIES: Capability[] = [
  {
    id: 'live-capture-hooks',
    label: 'Live-capture hooks',
    description: 'Automatic capture wired into the host tool’s lifecycle hooks.',
    requires: hasHooks,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': partial(
          'Hooks install, but the payload field names are not yet verified end-to-end against a live Gemini CLI.',
        ),
        'github-copilot': partial(
          'No lifecycle hooks; capture happens through the VS Code extension on file save, so non-VS-Code sessions are uncovered.',
        ),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no(NA_MANUAL),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'auto-prompt-capture',
    label: 'Auto prompt capture',
    description: 'Your prompts are recorded automatically as you submit them.',
    requires: hasHooks,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': partial(
          'Rides the same hook path; pending live verification (see live-capture hooks).',
        ),
        'github-copilot': partial(
          'Model-driven: the managed instructions ask Copilot to log prompts, but it is best-effort, not guaranteed.',
        ),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no(NA_MANUAL),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'auto-file-capture',
    label: 'Auto file/edit capture',
    description: 'Files the tool edits are snapshotted as artifacts automatically.',
    requires: hasHooks,
    cells: cells(
      {
        'claude-code': full(),
        codex: partial(
          'Edit-capture is implemented and passes contract tests, but a live apply_patch edit was not snapshotted in LLM-driven runs against this Codex build, so it is not yet live-certified (its prompt capture is).',
        ),
        'gemini-cli': partial(
          'Rides the same hook path; pending live verification (see live-capture hooks).',
        ),
        'github-copilot': partial(
          'The VS Code extension snapshots on save, but captures no AI-suggested diff and misses non-VS-Code edits.',
        ),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no(NA_MANUAL),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'auto-ai-output-capture',
    label: 'Auto AI-reply capture',
    description:
      'AI replies are captured and reconciled from the session transcript at stop.',
    requires: hasTranscript,
    cells: cells(
      {
        'claude-code': full(),
        codex: planned(
          'The reconcile logic is generic, but Codex exposes no session transcript, so the stop hook is a no-op until it does.',
        ),
        'gemini-cli': planned(
          'The reconcile logic is generic, but Gemini CLI exposes no session transcript, so the stop hook is a no-op until it does.',
        ),
        'github-copilot': no(
          'No hook or transcript surface; replies are never auto-captured.',
        ),
        chatgpt: no(
          NA_IMPORT + ' Replies arrive via import instead (see session import).',
        ),
        'google-gemini': no(
          NA_HOST + ' Replies arrive via import instead (see session import).',
        ),
        cli: no(NA_MANUAL),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'session-import',
    label: 'Session import / backfill',
    description:
      'Pull an existing conversation (share link, saved page, or on-disk transcript) into the trail.',
    requires: hasImport,
    cells: cells(
      {
        'claude-code': full(),
        chatgpt: full(),
        'google-gemini': full(),
        codex: no('Codex keeps no exportable transcript Showtail can read back.'),
        'gemini-cli': no(
          'Gemini CLI keeps no exportable transcript Showtail can read back.',
        ),
        'github-copilot': no('Copilot has no conversation export to import.'),
        cli: no('Nothing to import; the CLI logs events directly.'),
      },
      (id) => no(`No import capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'managed-instructions',
    label: 'Managed instructions',
    description:
      'Installs and maintains Showtail instructions/skill inside the host tool.',
    requires: hasConnect,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        chatgpt: no(NA_IMPORT + ' There is no model surface to instruct.'),
        'google-gemini': no(NA_HOST + ' There is no model surface to instruct.'),
        cli: no('The CLI is Showtail itself — no host instructions to manage.'),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'update-detection',
    label: 'Instruction update detection',
    description:
      'Detects stale or user-edited managed instructions and offers to refresh them.',
    cells: cells(
      {
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        'claude-code': partial(
          'The skill is rewritten wholesale with no managed-block fingerprint, so stale/edited skills are not detected (status reports no updateAvailable).',
        ),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no('No managed instructions to version.'),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'multi-scope-install',
    label: 'User + project install',
    description: 'Connect per-user (all projects) or per-project.',
    requires: hasBothScopes,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': partial(
          'Project-scoped only (.github/); there is no user-scope install.',
        ),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no('No install step.'),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'host-detection',
    label: 'Host detection (setup)',
    description:
      '`showtail setup` detects the tool on this machine and connects/guides accordingly.',
    requires: hasConnect,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        chatgpt: no(NA_HOST + ' Nothing to detect.'),
        'google-gemini': no(NA_HOST + ' Nothing to detect.'),
        cli: no('The CLI is always present — detection is moot.'),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'status-detection',
    label: 'Connection status',
    description: '`showtail status` reports whether the tool is connected and capturing.',
    requires: hasConnect,
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: partial(
          'Session state shows in `status`, but the CLI has no connect row of its own.',
        ),
      },
      (id) => no(`No connect capability for ${labelForTool(id)}.`),
    ),
  },
  {
    id: 'redaction',
    label: 'Secret/PII redaction',
    description: 'Secrets and personal data are scrubbed before anything is stored.',
    // Tool-agnostic: redaction runs in the event/log path for every tool.
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        chatgpt: full(),
        'google-gemini': full(),
        cli: full(),
      },
      () => full(),
    ),
  },
  {
    id: 'cross-tool-timeline',
    label: 'Cross-tool timeline',
    description:
      'Events from this tool appear, tagged, on the one unified report timeline.',
    // Tool-agnostic: every event carries its tool and joins the shared timeline.
    cells: cells(
      {
        'claude-code': full(),
        codex: full(),
        'gemini-cli': full(),
        'github-copilot': full(),
        chatgpt: full(),
        'google-gemini': full(),
        cli: full(),
      },
      () => full(),
    ),
  },
  {
    id: 'marketplace-install',
    label: 'Marketplace/extension install',
    description: 'One-command install from a plugin marketplace or extension gallery.',
    cells: cells(
      {
        'claude-code': full(),
        'github-copilot': full(),
        codex: no('No marketplace/extension surface to publish into.'),
        'gemini-cli': no('No marketplace/extension surface to publish into.'),
        chatgpt: no(NA_IMPORT),
        'google-gemini': no(NA_HOST),
        cli: no('Installed directly as the Showtail binary.'),
      },
      (id) => no(`No marketplace surface for ${labelForTool(id)}.`),
    ),
  },
];

// --- backing-test convention -----------------------------------------------

/** The end-to-end test id that must pass for a `full` cell to be legitimate. */
export function testIdFor(capabilityId: string, integration: IntegrationId): string {
  return `${capabilityId}:${integration}`;
}

/**
 * Capabilities whose `full` claim must be certified by an LLM-driven live run
 * (Tier B), not just a contract test — the edit-driven, hook-based capture
 * capabilities the live harness can actually trigger by driving the real tool to
 * edit a file. `auto-ai-output-capture` is deliberately excluded: it fires on the
 * host's Stop hook, which headless print mode never raises, so it can't be
 * LLM-driven this way — it stays `full` on the strength of its Stop-reconcile
 * contract E2E (tests/capability-backing.test.ts). Import/redaction/timeline
 * `full` cells are certified by contract tests against real recorded payloads.
 */
export const LIVE_CERTIFIED_CAPABILITIES = new Set([
  'live-capture-hooks',
  'auto-prompt-capture',
  'auto-file-capture',
]);

/** Every `full` cell, as `{ capabilityId, integration, testId, liveRequired }`. */
export function fullClaims(): Array<{
  capabilityId: string;
  integration: IntegrationId;
  testId: string;
  liveRequired: boolean;
}> {
  const out: Array<{
    capabilityId: string;
    integration: IntegrationId;
    testId: string;
    liveRequired: boolean;
  }> = [];
  for (const cap of CAPABILITIES) {
    for (const id of INTEGRATION_IDS) {
      if (cap.cells[id]!.status !== 'full') continue;
      out.push({
        capabilityId: cap.id,
        integration: id,
        testId: testIdFor(cap.id, id),
        liveRequired: LIVE_CERTIFIED_CAPABILITIES.has(cap.id) && id !== 'cli',
      });
    }
  }
  return out;
}

/**
 * Does this `full` cell satisfy the capability's structural requirement? Used by
 * the invariants test to forbid claiming `full` for, say, hook-based capture on
 * a plugin that declares no hooks adapter. Tool-agnostic capabilities (no
 * `requires`) always pass.
 */
export function fullClaimIsStructural(
  cap: Capability,
  integration: IntegrationId,
): boolean {
  if (!cap.requires) return true;
  return cap.requires(getPluginById(integration));
}

// --- rendering --------------------------------------------------------------

export const STATUS_GLYPH: Record<CapStatus, string> = {
  full: '✅ Full',
  partial: '🟡 Partial',
  planned: '🔵 Planned',
  'not-planned': '⚪ Not planned',
};

export interface MatrixRow {
  capability: Capability;
  cells: Array<{ integration: IntegrationId; cell: Cell }>;
}

/** Plain, serializable view of the matrix for `--json` (no functions). */
export function matrixJson(): {
  integrations: Array<{ id: IntegrationId; label: string }>;
  capabilities: Array<{
    id: string;
    label: string;
    description: string;
    cells: Record<IntegrationId, Cell>;
  }>;
} {
  return {
    integrations: INTEGRATION_IDS.map((id) => ({ id, label: labelForTool(id) })),
    capabilities: CAPABILITIES.map((cap) => ({
      id: cap.id,
      label: cap.label,
      description: cap.description,
      cells: cap.cells,
    })),
  };
}

/** Structured view of the matrix, for a future HTML page or JSON output. */
export function matrixRows(): MatrixRow[] {
  return CAPABILITIES.map((capability) => ({
    capability,
    cells: INTEGRATION_IDS.map((integration) => ({
      integration,
      cell: capability.cells[integration]!,
    })),
  }));
}

/**
 * Render the matrix as a GitHub-flavored Markdown table plus numbered footnotes
 * for every non-full cell's note. This exact text is what lives in README's
 * managed block and what `showtail matrix` prints.
 */
export function renderMatrixMarkdown(): string {
  const header = ['Capability', ...INTEGRATION_IDS.map((id) => labelForTool(id))];
  const divider = header.map(() => '---');

  // Collect unique notes in first-seen order; identical notes share a number.
  const footnotes: string[] = [];
  const numberForNote = new Map<string, number>();
  const noteNumber = (note: string): number => {
    let n = numberForNote.get(note);
    if (!n) {
      footnotes.push(note);
      n = footnotes.length;
      numberForNote.set(note, n);
    }
    return n;
  };

  const rows = CAPABILITIES.map((cap) => {
    const cellsText = INTEGRATION_IDS.map((id) => {
      const cell = cap.cells[id]!;
      return cell.note
        ? `${STATUS_GLYPH[cell.status]} [${noteNumber(cell.note)}]`
        : STATUS_GLYPH[cell.status];
    });
    return [`**${cap.label}**`, ...cellsText];
  });

  const toLine = (cellsArr: string[]) => `| ${cellsArr.join(' | ')} |`;
  const lines = [
    toLine(header),
    toLine(divider),
    ...rows.map(toLine),
    '',
    '**Legend:** ✅ fully implemented · 🟡 partial (see notes) · 🔵 planned · ⚪ not planned (constraint).',
  ];

  if (footnotes.length) {
    lines.push('', '**Notes:**', '');
    footnotes.forEach((note, i) => lines.push(`${i + 1}. ${note}`));
  }

  return lines.join('\n');
}
