import { resolve } from 'node:path';
import { activeAuthorPaths } from '../core/authors.ts';
import { ShowtailError } from '../core/errors.ts';
import { readSessionEvents } from '../core/events.ts';
import { readGlobalConfig, toolCaptureGloballyDisabled } from '../core/globalConfig.ts';
import {
  knownTrailPath,
  sessionProjectContext,
  sessionSignal,
  unplacedSessions,
} from '../core/ledger.ts';
import { emitJson } from '../core/output.ts';
import {
  assertProjectCommandIdentity,
  pinProjectCommandIdentity,
  resolveProjectCommandTarget,
  type ProjectSelection,
} from '../core/projectCatalog.ts';
import { currentSession } from '../core/sessions.ts';
import {
  pathsForRoot,
  readConfig,
  resolveProjectContext,
  samePath,
  isEligibleAnchor,
  trailIsNewerThanBinary,
  type ProjectEvidence,
} from '../core/storage.ts';
import { pluralS } from '../core/text.ts';
import {
  connectedToolsLines,
  toolCaptureStatus,
  toolStatuses,
  type ToolCaptureStatus,
  type ToolStatus,
} from '../core/tools.ts';
import { cachedUpdateStatus } from '../core/updateCheck.ts';
import type { Config } from '../types.ts';
import { EVENT_TYPES } from '../types.ts';
import { pendingRangeSummariesForRoot, type PendingRangeSummary } from './ranges.ts';

/** Count of globally-captured sessions awaiting placement (best-effort; never throws). */
function inboxCount(): number {
  try {
    return unplacedSessions({ repairTargets: false }).length;
  } catch {
    return 0;
  }
}

export interface StatusOptions {
  /** Emit machine-readable JSON (consumed by managed tool instructions). */
  json?: boolean;
  cwd?: string;
  /** True when cwd came from the optional `status [path]` argument. */
  explicitPath?: boolean;
  /** Select a known project without relying on the caller's cwd. */
  project?: string;
  /** Include pending-work arrays instead of compact counts in JSON. */
  verboseJson?: boolean;
  /** Report capture guidance for one tool (CLI name, id, or alias). */
  tool?: string;
}

export type StatusNextAction = 'run-setup' | 'work' | 'report';

export interface StatusSnapshot {
  initialized: boolean;
  /** Stable identity of the selected live trail, or null before initialization. */
  trailId: string | null;
  /** Metadata-first selector result when `--project` was used. */
  selection?: ProjectSelection;
  /** Canonical operand supplied to `status [path]`; omitted for a bare probe. */
  requestedRoot?: string;
  root: string | null;
  candidateRoot: string | null;
  evidence: ProjectEvidence | null;
  candidates: string[];
  anchorKind: Config['anchorKind'] | null;
  trailNewer: boolean;
  /** A malformed/incomplete trail never makes the status probe fail. */
  trailError: string | null;
  session: {
    id: string;
    label: string | null;
    startedAt: string;
    events: number;
    byType: Record<string, number>;
  } | null;
  /** Legacy Claude-oriented field retained for one compatibility release. */
  hooksActive: boolean;
  capture?: ToolCaptureStatus;
  /** True only when a bare disconnect established a machine-wide runtime stop. */
  captureGloballyDisabled?: boolean;
  autoInit: boolean;
  setupCompleted: boolean;
  relocated: { previousPath: string; duplicated: boolean } | null;
  matchingPendingSessions: Array<{
    id: string;
    tool: string;
    nativeSessionId: string;
    prompts: number;
    edits: number;
  }>;
  pendingAmbiguous: Array<{ id: string; candidates: string[] }>;
  /** Turn-level work related to this project that still needs placement review. */
  pendingRanges: PendingRangeSummary[];
  inbox: number;
  nextAction: StatusNextAction;
  update: ReturnType<typeof cachedUpdateStatus>;
  tools: ToolStatus[];
}

function matchingPendingWork(
  root: string | null,
): Pick<StatusSnapshot, 'matchingPendingSessions' | 'pendingAmbiguous'> {
  const matchingPendingSessions: StatusSnapshot['matchingPendingSessions'] = [];
  const pendingAmbiguous: StatusSnapshot['pendingAmbiguous'] = [];
  if (!root) return { matchingPendingSessions, pendingAmbiguous };

  try {
    for (const pending of unplacedSessions({
      includeHidden: true,
      repairTargets: false,
    })) {
      const signal = sessionSignal(pending.id);
      if (signal.prompts === 0 && signal.edits === 0) continue;
      const context = sessionProjectContext(pending);
      if (context.state === 'tracked' || context.state === 'candidate') {
        if (!samePath(context.root, root)) continue;
        matchingPendingSessions.push({
          id: pending.id,
          tool: pending.tool,
          nativeSessionId: pending.nativeSessionId,
          prompts: signal.prompts,
          edits: signal.edits,
        });
      } else if (
        context.state === 'ambiguous' &&
        context.candidates.some((candidate) => samePath(candidate, root))
      ) {
        pendingAmbiguous.push({ id: pending.id, candidates: context.candidates });
      }
    }
  } catch {
    // Status is an orientation probe; unreadable ledger state is reported as empty.
  }
  return { matchingPendingSessions, pendingAmbiguous };
}

/** Observe a moved/copied trail without updating machine-local ledger state. */
function observedRelocation(root: string, config: Config): StatusSnapshot['relocated'] {
  if (!config.trailId) return null;
  const previousPath = knownTrailPath(config.trailId);
  if (!previousPath || samePath(previousPath, root)) return null;
  let duplicated = false;
  try {
    duplicated = readConfig(pathsForRoot(previousPath)).trailId === config.trailId;
  } catch {
    // A missing/unreadable previous trail is a move, not a live duplicate.
  }
  return { previousPath, duplicated };
}

/**
 * Build the read-only state probe shared by `status` and `capabilities`.
 * It intentionally performs no identity upgrades, registry writes, relocation
 * updates, trail creation, or session changes.
 */
export function buildStatusSnapshot(options: StatusOptions = {}): StatusSnapshot {
  const callerCwd = resolve(options.cwd ?? process.cwd());
  const target = options.project
    ? resolveProjectCommandTarget(options.project, {
        cwd: callerCwd,
        allowUntrackedPath: true,
      })
    : null;
  const cwd = resolve(target?.root ?? callerCwd);
  const requestedRoot = options.explicitPath || options.project ? cwd : null;
  if (requestedRoot && !isEligibleAnchor(requestedRoot)) {
    throw new ShowtailError(
      `Folder does not exist: ${requestedRoot}`,
      2,
      {
        requestedRoot,
        root: null,
        candidateRoot: null,
        candidates: [],
      },
      'PATH_NOT_FOUND',
      'choose-existing-path',
    );
  }
  const context = resolveProjectContext({
    cwd,
    explicitPath: options.explicitPath || options.project !== undefined,
  });
  const initialized = context.state === 'tracked';
  const root = initialized ? context.root : null;
  const candidateRoot = context.state === 'candidate' ? context.root : null;
  const candidates = context.state === 'ambiguous' ? context.candidates : [];
  const evidence =
    context.state === 'tracked' || context.state === 'candidate'
      ? context.evidence
      : null;
  const identityPin = pinProjectCommandIdentity(
    root ?? candidateRoot ?? cwd,
    target?.selection,
  );

  let anchorKind: Config['anchorKind'] | null = null;
  let trailId: string | null = null;
  let trailNewer = false;
  let trailError: string | null = null;
  let relocated: StatusSnapshot['relocated'] = null;
  let session: StatusSnapshot['session'] = null;

  if (root) {
    const paths = pathsForRoot(root);
    try {
      const config = readConfig(paths);
      trailId = config.trailId ?? null;
      anchorKind = config.anchorKind ?? null;
      trailNewer = trailIsNewerThanBinary(paths);
      relocated = observedRelocation(root, config);
      const author = activeAuthorPaths(paths);
      const current = author ? currentSession(author) : null;
      if (author && current) {
        const events = readSessionEvents(author, current.id);
        const counts: Partial<Record<string, number>> = {};
        for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
        session = {
          id: current.id,
          label: current.label ?? null,
          startedAt: current.startedAt,
          events: events.length,
          byType: Object.fromEntries(
            EVENT_TYPES.flatMap((type) => {
              const count = counts[type];
              return count ? [[type, count]] : [];
            }),
          ),
        };
      }
    } catch (error) {
      trailError = error instanceof Error ? error.message : String(error);
    }
  }

  const global = readGlobalConfig();
  const autoInit = global.autoInit === true;
  const setupCompleted = Boolean(global.setupCompletedAt);
  const allTools = toolStatuses(cwd);
  const legacyClaudeHooks =
    allTools.find((candidate) => candidate.tool === 'claude')?.hooksActive ?? false;
  const capture = options.tool ? toolCaptureStatus(options.tool, allTools) : undefined;
  const captureGloballyDisabled = capture
    ? toolCaptureGloballyDisabled(capture.tool)
    : undefined;
  const tools = capture
    ? allTools.filter((candidate) => candidate.tool === capture.tool)
    : allTools;
  const inbox = inboxCount();
  const pending = matchingPendingWork(root ?? candidateRoot);
  const pendingRanges = pendingRangeSummariesForRoot(root ?? candidateRoot, {
    persist: false,
  });
  const nextAction: StatusNextAction =
    (session && session.events > 0) ||
    pending.matchingPendingSessions.length > 0 ||
    pendingRanges.some((range) => range.reason === 'awaiting project placement')
      ? 'report'
      : !autoInit
        ? 'run-setup'
        : 'work';

  assertProjectCommandIdentity(identityPin);

  return {
    initialized,
    trailId,
    ...(target?.selection ? { selection: target.selection } : {}),
    ...(requestedRoot ? { requestedRoot } : {}),
    root,
    candidateRoot,
    evidence,
    candidates,
    anchorKind,
    trailNewer,
    trailError,
    session,
    hooksActive: legacyClaudeHooks,
    ...(capture ? { capture } : {}),
    ...(captureGloballyDisabled !== undefined ? { captureGloballyDisabled } : {}),
    autoInit,
    setupCompleted,
    relocated,
    ...pending,
    pendingRanges,
    inbox,
    nextAction,
    update: cachedUpdateStatus(),
    tools,
  };
}

/** Show project/global capture state. Safe to call from any folder. */
export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const snapshot = buildStatusSnapshot(options);
  if (options.json) {
    if (options.verboseJson) {
      emitJson(snapshot);
    } else {
      const { matchingPendingSessions, pendingAmbiguous, pendingRanges, ...compact } =
        snapshot;
      emitJson({
        ...compact,
        pending: {
          matchingSessions: matchingPendingSessions.length,
          ambiguousSessions: pendingAmbiguous.length,
          ranges: pendingRanges.length,
        },
      });
    }
    return;
  }

  if (snapshot.trailNewer) {
    console.log(
      'Note: this trail was written by a newer Showtail — some sessions may not be ' +
        'visible. Run `showtail update` to see everything.',
    );
    console.log('');
  }

  if (snapshot.trailError) {
    console.log(
      `Showtail found the project trail, but could not read it: ${snapshot.trailError}`,
    );
    console.log(
      'Restore or inspect `.showtail/config.json` from version control or a backup; Showtail will not overwrite an unreadable trail.',
    );
    console.log('');
  }

  if (snapshot.relocated) {
    if (snapshot.relocated.duplicated) {
      console.log(
        'Warning: this trail also still exists at ' +
          `${snapshot.relocated.previousPath} — it looks copied, not moved.`,
      );
      console.log(
        '  Two folders now share one trail id, so new work may be recorded against',
      );
      console.log('  the other copy. Delete the copy you are not using.');
    } else {
      console.log(
        `This project appears to have moved here from ${snapshot.relocated.previousPath}.`,
      );
    }
    console.log('');
  }

  if (snapshot.initialized) {
    if (snapshot.session) {
      const label = snapshot.session.label ? `  "${snapshot.session.label}"` : '';
      console.log(`Session  ${snapshot.session.id}${label}`);
      const when = new Date(snapshot.session.startedAt).toLocaleString();
      console.log(
        `  started ${when} · ${snapshot.session.events} event${pluralS(snapshot.session.events)}`,
      );
      const breakdown = EVENT_TYPES.flatMap((type) => {
        const count = snapshot.session?.byType[type];
        return count ? [`${count} ${type}`] : [];
      });
      if (breakdown.length > 0) console.log('  ' + breakdown.join(' · '));
    } else {
      console.log(
        'No open session yet — just start working and one opens automatically.',
      );
    }
  } else if (snapshot.candidateRoot) {
    console.log('No Showtail trail exists here yet.');
    console.log(`  project ${snapshot.candidateRoot}`);
    console.log(`  evidence ${snapshot.evidence}`);
    console.log(
      snapshot.matchingPendingSessions.length > 0
        ? `${snapshot.matchingPendingSessions.length} captured session(s) already match; \`showtail report\` will create the trail and include them.`
        : snapshot.autoInit
          ? 'It will be created automatically when the first prompt is captured.'
          : 'Automatic tracking is off — run `showtail setup` to enable it.',
    );
  } else if (snapshot.candidates.length > 0) {
    console.log('No single project could be selected for this folder.');
    for (const candidate of snapshot.candidates) console.log(`  ${candidate}`);
  } else {
    console.log('No Showtail project context could be resolved for this folder.');
  }

  if (snapshot.inbox > 0) {
    console.log('');
    console.log(
      `${snapshot.inbox} session${pluralS(snapshot.inbox)} captured but not yet placed in a project — run \`showtail inbox\`.`,
    );
  }
  if (snapshot.pendingAmbiguous.length > 0) {
    console.log(
      `${snapshot.pendingAmbiguous.length} session${pluralS(snapshot.pendingAmbiguous.length)} also mention this project but span multiple roots; they remain in the inbox.`,
    );
  }
  if (snapshot.pendingRanges.length > 0) {
    console.log(
      `${snapshot.pendingRanges.length} captured turn range${pluralS(snapshot.pendingRanges.length)} related to this project still need placement review — run \`showtail inbox\`.`,
    );
  }

  console.log('');
  console.log('Connected tools');
  const lines = connectedToolsLines(snapshot.tools);
  if (lines.length > 0) {
    for (const line of lines) console.log(line);
  } else if (snapshot.capture) {
    console.log(`  ${snapshot.capture.tool.padEnd(8)} not connected`);
  }
}
