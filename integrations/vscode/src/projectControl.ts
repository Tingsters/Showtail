import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  SHOWTAIL_PROJECT_CONTROL_PROTOCOL,
  createProjectControlMarker,
  parseOptionalProjectPath,
  parseProjectResolution,
  parseReportResult,
  parseResolvedProjectCommandResult,
  parseStoredProjectControlClaims,
  projectsArgs,
  reportArgs,
  reportPathFromClaim,
  statusArgs,
  verifyArgs,
  type CliResult,
  type ExtensionHookTool,
  type ProjectControlAction,
  type ProjectControlMarker,
  type ProjectResolution,
  type ProjectSelection,
  type StoredProjectControlClaim,
} from './showtailProtocol';

const CLAIMS_KEY = 'showtail.projectControl.claims.v1';
const FOCUS_KEY = 'showtail.projectControl.focus.v1';
const MAX_CLAIMS = 20;
const MAX_COMPLETED_PRIOR_CLAIMS = 50;
const COMPLETED_PRIOR_CLAIM_FALLBACK_MS = 1_000;
const MAX_TOOL_OUTPUT_BYTES = 7_900;
const TRUNCATION_NOTICE =
  '\n... output truncated; run the command directly for verbose diagnostics.';

export interface ProjectControlInput {
  action: ProjectControlAction;
  selector?: string;
  priorClaimId?: string;
}

export interface ProjectControlExecutionOptions {
  selectorSource?: 'user' | 'semantic';
  /** Opaque VS Code token tying duplicate delivery to one native chat request. */
  requestIdentity?: unknown;
}

export type ProjectControlExecution =
  | {
      ok: true;
      action: ProjectControlAction;
      selection: ProjectSelection;
      marker: ProjectControlMarker;
      text: string;
      reportPath?: string;
      opened?: boolean;
    }
  | {
      ok: false;
      action: ProjectControlAction;
      message: string;
      resolution?: ProjectResolution;
    };

type RunShowtail = (args: string[], cwd: string) => Promise<CliResult>;
type FocusSource = 'edit' | 'picker' | 'control';

interface StoredProjectFocus extends ProjectSelection {
  source: FocusSource;
  workspaceContext: string;
  activationId: string;
  updatedAt: string;
}

interface ProjectQuickPickItem extends vscode.QuickPickItem {
  selection: ProjectSelection;
}

interface InFlightPriorClaim {
  action: ProjectControlAction;
  requestIdentity?: unknown;
  execution: Promise<ProjectControlExecution>;
}

interface CompletedPriorClaim {
  execution: Extract<ProjectControlExecution, { ok: true }>;
  completedAt: number;
  requestIdentity?: unknown;
}

function cleanInput(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanSelector(value: unknown): string | undefined {
  const input = cleanInput(value);
  if (!input) return undefined;
  const path = parseOptionalProjectPath(input);
  return path.ok && path.path ? path.path : input;
}

function canonicalLocalPath(value: string): string {
  const resolved = resolve(value);
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

function sameLocalPath(left: string, right: string): boolean {
  const a = canonicalLocalPath(left);
  const b = canonicalLocalPath(right);
  return a === b;
}

function workspaceContextId(roots: string[]): string {
  const canonicalRoots = [...new Set(roots.map(canonicalLocalPath))].sort();
  return createHash('sha256').update(canonicalRoots.join('\0')).digest('hex');
}

function canonicalTokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function selectorContainsCompleteDisplayName(
  selector: string,
  selection: ProjectSelection,
): boolean {
  const nameTokens = canonicalTokens(selection.displayName);
  if (nameTokens.length < 2) return false;
  const available = new Map<string, number>();
  for (const token of canonicalTokens(selector)) {
    available.set(token, (available.get(token) ?? 0) + 1);
  }
  for (const token of nameTokens) {
    const remaining = available.get(token) ?? 0;
    if (remaining === 0) return false;
    available.set(token, remaining - 1);
  }
  return true;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Length(value) <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(value.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const truncated = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function boundedOutput(value: string): string {
  const text = value.trim();
  if (utf8Length(text) <= MAX_TOOL_OUTPUT_BYTES) return text;
  const bodyBudget = MAX_TOOL_OUTPUT_BYTES - utf8Length(TRUNCATION_NOTICE);
  return `${truncateUtf8(text, bodyBudget)}${TRUNCATION_NOTICE}`;
}

function requiresExplicitPath(selection: Pick<ProjectSelection, 'evidence'>): boolean {
  return selection.evidence.includes('duplicate-trail-explicit-path');
}

function selectorForSelection(selection: ProjectSelection): string {
  return requiresExplicitPath(selection) ? selection.root : selection.trailId;
}

function resolutionMessage(resolution: ProjectResolution): string {
  if (resolution.message) return resolution.message;
  if (resolution.state === 'conflict') {
    return 'Showtail found conflicting project evidence. Choose the intended project locally.';
  }
  if (resolution.state === 'ambiguous') {
    return 'Showtail found more than one possible project.';
  }
  if (resolution.state === 'confirmation-required') {
    return 'Showtail needs confirmation before using this project.';
  }
  return 'Showtail could not find a matching project.';
}

export class ProjectControlController {
  private readonly activationId = randomUUID();
  private readonly inFlightPriorClaims = new Map<string, InFlightPriorClaim>();
  private readonly inFlightOpenReports = new Map<
    string,
    Promise<ProjectControlExecution>
  >();
  private readonly completedPriorClaims = new Map<string, CompletedPriorClaim>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runShowtail: RunShowtail,
    private readonly output: vscode.OutputChannel,
    private readonly captureTool: () => ExtensionHookTool,
  ) {}

  private workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  private workspaceContext(): string {
    return workspaceContextId(this.workspaceRoots());
  }

  private selectionForWindow(selection: ProjectSelection): ProjectSelection {
    const roots = this.workspaceRoots();
    const crossWorkspace =
      roots.length > 0 && !roots.some((root) => sameLocalPath(root, selection.root));
    const { crossWorkspace: _cliCrossWorkspace, ...identity } = selection;
    return {
      ...identity,
      ...(crossWorkspace ? { crossWorkspace: true } : {}),
    };
  }

  private focus(): StoredProjectFocus | undefined {
    const value = this.context.workspaceState.get<StoredProjectFocus>(FOCUS_KEY);
    return value &&
      typeof value.trailId === 'string' &&
      typeof value.root === 'string' &&
      (value.source === 'edit' ||
        value.source === 'picker' ||
        value.source === 'control') &&
      typeof value.activationId === 'string' &&
      value.workspaceContext === this.workspaceContext()
      ? value
      : undefined;
  }

  private trustedEditFocus(): StoredProjectFocus | undefined {
    const focus = this.focus();
    return focus?.source === 'edit' && focus.activationId === this.activationId
      ? focus
      : undefined;
  }

  private async rememberFocus(
    selection: ProjectSelection,
    source: FocusSource,
  ): Promise<void> {
    await this.context.workspaceState.update(FOCUS_KEY, {
      ...selection,
      source,
      workspaceContext: this.workspaceContext(),
      activationId: this.activationId,
      updatedAt: new Date().toISOString(),
    } satisfies StoredProjectFocus);
    this.output.appendLine(
      `Showtail project focus: ${selection.displayName} (${selection.trailId}, ${source}).`,
    );
  }

  private async query(selector?: string): Promise<ProjectResolution> {
    return parseProjectResolution(
      await this.runShowtail(projectsArgs(selector), homedir()),
    );
  }

  private sortedCandidates(candidates: ProjectSelection[]): ProjectSelection[] {
    const focus = this.focus();
    return [...candidates].sort((left, right) => {
      const leftFocused = focus?.trailId === left.trailId ? 1 : 0;
      const rightFocused = focus?.trailId === right.trailId ? 1 : 0;
      if (leftFocused !== rightFocused) return rightFocused - leftFocused;
      return left.displayName.localeCompare(right.displayName);
    });
  }

  private async pickCandidate(
    resolution: ProjectResolution,
  ): Promise<ProjectSelection | undefined> {
    const focus = this.focus();
    const items: ProjectQuickPickItem[] = this.sortedCandidates(
      resolution.candidates,
    ).map((candidate) => ({
      label: candidate.displayName,
      description: candidate.root,
      detail:
        focus?.trailId === candidate.trailId
          ? `Last edit-backed Showtail focus - ${candidate.trailId}`
          : candidate.trailId,
      selection: candidate,
    }));
    if (items.length === 0) return undefined;
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Choose the project for this Showtail command',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.selection;
  }

  private async validateExactSelection(
    expected: Pick<ProjectSelection, 'trailId' | 'root' | 'evidence'>,
  ): Promise<ProjectSelection | undefined> {
    const pinRoot = requiresExplicitPath(expected);
    const validation = await this.query(pinRoot ? expected.root : expected.trailId);
    if (
      validation.state !== 'selected' ||
      !validation.selection ||
      validation.selection.trailId !== expected.trailId ||
      (pinRoot && !sameLocalPath(validation.selection.root, expected.root))
    ) {
      return undefined;
    }
    return this.selectionForWindow(validation.selection);
  }

  private async resolveSelection(
    selector: string | undefined,
    token?: vscode.CancellationToken,
    selectorSource: 'user' | 'semantic' = 'user',
  ): Promise<
    | { ok: true; selection: ProjectSelection }
    | { ok: false; message: string; resolution: ProjectResolution }
  > {
    const resolution = await this.query(selector);
    if (token?.isCancellationRequested) {
      return { ok: false, message: 'The Showtail command was cancelled.', resolution };
    }
    if (resolution.state === 'selected' && resolution.selection) {
      const selection = this.selectionForWindow(resolution.selection);
      if (
        selectorSource !== 'semantic' ||
        !selector ||
        selection.mode !== 'authoritative'
      ) {
        return { ok: true, selection };
      }
      const confirmed = await this.pickCandidate({
        ...resolution,
        state: 'confirmation-required',
        selection: undefined,
        candidates: [selection],
        message: 'A model-supplied selector cannot authorize a project path or trail ID.',
      });
      if (!confirmed) {
        return {
          ok: false,
          message: 'Confirm the project locally before Showtail runs this command.',
          resolution,
        };
      }
      const validated = await this.validateExactSelection(confirmed);
      if (!validated) {
        return {
          ok: false,
          message: 'That project changed before Showtail could use it. Choose it again.',
          resolution,
        };
      }
      await this.rememberFocus(validated, 'picker');
      return { ok: true, selection: validated };
    }

    if (resolution.state === 'conflict') {
      return {
        ok: false,
        message:
          resolution.message ??
          'This trail ID is live in more than one folder. Repair or remove the copied trail before running a project control.',
        resolution,
      };
    }

    const editFocus = this.trustedEditFocus();
    const focusedCandidate =
      selectorSource === 'semantic' &&
      selector &&
      resolution.state === 'confirmation-required' &&
      resolution.candidates.length === 1 &&
      editFocus &&
      resolution.candidates[0]?.trailId === editFocus.trailId &&
      sameLocalPath(resolution.candidates[0].root, editFocus.root) &&
      selectorContainsCompleteDisplayName(selector, resolution.candidates[0])
        ? resolution.candidates[0]
        : undefined;
    if (focusedCandidate) {
      const validated = await this.validateExactSelection(focusedCandidate);
      if (!validated) {
        return {
          ok: false,
          message: 'That project changed before Showtail could use it. Choose it again.',
          resolution,
        };
      }
      return {
        ok: true,
        selection: {
          ...validated,
          mode: 'corroborated',
          evidence: ['complete-name', 'trusted-edit-focus', 'live-config'],
        },
      };
    }

    const picked = await this.pickCandidate(resolution);
    if (!picked) {
      return { ok: false, message: resolutionMessage(resolution), resolution };
    }
    const validated = await this.validateExactSelection(picked);
    if (!validated) {
      return {
        ok: false,
        message: 'That project changed before Showtail could use it. Choose it again.',
        resolution,
      };
    }
    await this.rememberFocus(validated, 'picker');
    return { ok: true, selection: validated };
  }

  private commandCwd(selection: ProjectSelection): string {
    return existsSync(selection.root) ? selection.root : homedir();
  }

  private claims(): StoredProjectControlClaim[] {
    return parseStoredProjectControlClaims(
      this.context.globalState.get<unknown>(CLAIMS_KEY),
    );
  }

  private async storeClaim(marker: ProjectControlMarker): Promise<void> {
    const claims = this.claims().filter((claim) => claim.claimId !== marker.claimId);
    claims.unshift({ ...marker, createdAt: new Date().toISOString() });
    await this.context.globalState.update(CLAIMS_KEY, claims.slice(0, MAX_CLAIMS));
  }

  private async consumeClaim(claimId: string | undefined): Promise<void> {
    if (!claimId) return;
    const claims = this.claims().filter((claim) => claim.claimId !== claimId);
    await this.context.globalState.update(CLAIMS_KEY, claims);
  }

  private claim(claimId: string | undefined): StoredProjectControlClaim | undefined {
    if (!claimId) return undefined;
    return this.claims().find((claim) => claim.claimId === claimId);
  }

  private reusableReport(
    selection: ProjectSelection,
  ): { claim: StoredProjectControlClaim; path: string } | undefined {
    const candidates = this.claims()
      .filter(
        (claim) =>
          (claim.action === 'report' || claim.action === 'open_report') &&
          claim.trailId === selection.trailId &&
          sameLocalPath(claim.root, selection.root),
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    for (const claim of candidates) {
      const path = reportPathFromClaim(claim, selection);
      if (path && existsSync(path)) return { claim, path };
    }
    return undefined;
  }

  private async openReport(path: string): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(document);
      return true;
    } catch (error) {
      this.output.appendLine(
        `Showtail could not open ${path}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async finish(
    action: ProjectControlAction,
    selection: ProjectSelection,
    text: string,
    reportPath?: string,
    opened?: boolean,
    consumedClaimId?: string,
  ): Promise<ProjectControlExecution> {
    const marker = createProjectControlMarker(
      randomUUID(),
      action,
      selection,
      reportPath,
    );
    await this.consumeClaim(consumedClaimId);
    await this.storeClaim(marker);
    await this.rememberFocus(selection, 'control');
    return {
      ok: true,
      action,
      selection,
      marker,
      text: boundedOutput(text),
      ...(reportPath ? { reportPath } : {}),
      ...(opened !== undefined ? { opened } : {}),
    };
  }

  private async generateReport(
    action: 'report' | 'open_report',
    selection: ProjectSelection,
    shouldOpen: boolean,
    consumedClaimId?: string,
  ): Promise<ProjectControlExecution> {
    const projectSelector = selectorForSelection(selection);
    const parsed = parseReportResult(
      await this.runShowtail(reportArgs(projectSelector), this.commandCwd(selection)),
      selection.root,
      {
        exactRoot: true,
        expectedTrailId: selection.trailId,
        disallowedAncestorRoots: [homedir()],
      },
    );
    if (!parsed.ok) {
      return { ok: false, action, message: parsed.message };
    }
    const opened = shouldOpen ? await this.openReport(parsed.path) : undefined;
    const resultText = shouldOpen
      ? opened
        ? `Opened the Showtail report at ${parsed.path}.`
        : `The Showtail report is ready at ${parsed.path}, but VS Code could not open it.`
      : `Generated the Showtail report at ${parsed.path}.`;
    const pendingText = parsed.pendingRangeCount
      ? `${parsed.pendingRangeCount} captured work ${
          parsed.pendingRangeCount === 1 ? 'range still needs' : 'ranges still need'
        } placement. Run showtail inbox.`
      : undefined;
    const text = pendingText ? `${resultText}\n\n${pendingText}` : resultText;
    return this.finish(action, selection, text, parsed.path, opened, consumedClaimId);
  }

  private async tryPriorClaim(
    priorClaimId: string | undefined,
  ): Promise<
    | { claim: StoredProjectControlClaim; selection: ProjectSelection; path?: string }
    | undefined
  > {
    const claim = this.claim(priorClaimId);
    if (!claim) return undefined;
    const selection = await this.validateExactSelection(claim);
    if (!selection) return undefined;
    const path = reportPathFromClaim(claim, selection);
    return { claim, selection, ...(path && existsSync(path) ? { path } : {}) };
  }

  async noteEditProject(path: string): Promise<void> {
    const resolution = await this.query(dirname(path));
    if (resolution.state === 'selected' && resolution.selection) {
      await this.rememberFocus(this.selectionForWindow(resolution.selection), 'edit');
    }
  }

  private async executeSelection(
    action: ProjectControlAction,
    selection: ProjectSelection,
    consumedClaimId?: string,
  ): Promise<ProjectControlExecution> {
    if (action === 'report' || action === 'open_report') {
      return this.generateReport(
        action,
        selection,
        action === 'open_report',
        consumedClaimId,
      );
    }

    const projectSelector = selectorForSelection(selection);
    const args =
      action === 'verify'
        ? verifyArgs(projectSelector)
        : statusArgs(projectSelector, this.captureTool());
    const parsed = parseResolvedProjectCommandResult(
      await this.runShowtail(args, this.commandCwd(selection)),
      selection,
    );
    if (!parsed.ok) {
      return { ok: false, action, message: parsed.text };
    }
    return this.finish(
      action,
      selection,
      parsed.text,
      undefined,
      undefined,
      consumedClaimId,
    );
  }

  private async executeOnce(
    action: ProjectControlAction,
    selector: string | undefined,
    priorClaimId: string | undefined,
    token?: vscode.CancellationToken,
    options: ProjectControlExecutionOptions = {},
  ): Promise<ProjectControlExecution> {
    if (!selector && priorClaimId) {
      const prior = await this.tryPriorClaim(priorClaimId);
      if (action === 'open_report' && prior?.path) {
        const opened = await this.openReport(prior.path);
        return this.finish(
          action,
          prior.selection,
          opened
            ? `Opened the existing Showtail report at ${prior.path}.`
            : `The existing Showtail report is at ${prior.path}, but VS Code could not open it.`,
          prior.path,
          opened,
          prior.claim.claimId,
        );
      }
      if (prior) {
        return this.executeSelection(action, prior.selection, prior.claim.claimId);
      }
    }

    const resolved = await this.resolveSelection(selector, token, options.selectorSource);
    if (!resolved.ok) {
      return {
        ok: false,
        action,
        message: resolved.message,
        resolution: resolved.resolution,
      };
    }
    if (token?.isCancellationRequested) {
      return { ok: false, action, message: 'The Showtail command was cancelled.' };
    }
    const selection = resolved.selection;
    if (action === 'open_report' && !selector) {
      const reusable = this.reusableReport(selection);
      if (reusable) {
        const opened = await this.openReport(reusable.path);
        return this.finish(
          action,
          selection,
          opened
            ? `Opened the existing Showtail report at ${reusable.path}.`
            : `The existing Showtail report is at ${reusable.path}, but VS Code could not open it.`,
          reusable.path,
          opened,
          reusable.claim.claimId,
        );
      }
    }
    return this.executeSelection(action, selection);
  }

  private completedClaimBelongsToRequest(
    completed: CompletedPriorClaim,
    requestIdentity: unknown,
  ): boolean {
    if (completed.requestIdentity !== undefined || requestIdentity !== undefined) {
      return Object.is(completed.requestIdentity, requestIdentity);
    }
    const age = Date.now() - completed.completedAt;
    return age >= 0 && age <= COMPLETED_PRIOR_CLAIM_FALLBACK_MS;
  }

  private async replayCompletedPriorClaim(
    action: ProjectControlAction,
    completed: CompletedPriorClaim,
    token?: vscode.CancellationToken,
  ): Promise<ProjectControlExecution> {
    const selection = await this.validateExactSelection(completed.execution.selection);
    if (token?.isCancellationRequested) {
      return { ok: false, action, message: 'The Showtail command was cancelled.' };
    }
    if (!selection) {
      return {
        ok: false,
        action,
        message: 'That project changed before Showtail could reuse the prior result.',
      };
    }

    const sameProject =
      selection.trailId === completed.execution.selection.trailId &&
      sameLocalPath(selection.root, completed.execution.selection.root);
    const reportStillExists =
      action !== 'report' && action !== 'open_report'
        ? true
        : completed.execution.reportPath !== undefined &&
          existsSync(completed.execution.reportPath);
    if (sameProject && reportStillExists) return completed.execution;

    return this.executeSelection(action, selection);
  }

  async execute(
    rawInput: ProjectControlInput,
    token?: vscode.CancellationToken,
    options: ProjectControlExecutionOptions = {},
  ): Promise<ProjectControlExecution> {
    const action = rawInput.action;
    const selector = cleanSelector(rawInput.selector);
    const suppliedPriorClaimId = cleanInput(rawInput.priorClaimId);
    const priorClaimId = selector ? undefined : suppliedPriorClaimId;
    if (!priorClaimId) {
      if (action !== 'open_report') {
        return this.executeOnce(action, selector, undefined, token, options);
      }
      const openKey = `${selector ?? ''}\0${options.selectorSource ?? 'user'}`;
      const existingOpen = this.inFlightOpenReports.get(openKey);
      if (existingOpen) return existingOpen;
      const execution = this.executeOnce(action, selector, undefined, token, options);
      this.inFlightOpenReports.set(openKey, execution);
      try {
        return await execution;
      } finally {
        if (this.inFlightOpenReports.get(openKey) === execution) {
          this.inFlightOpenReports.delete(openKey);
        }
      }
    }

    const existing = this.inFlightPriorClaims.get(priorClaimId);
    if (existing) {
      if (
        existing.action === action &&
        Object.is(existing.requestIdentity, options.requestIdentity)
      ) {
        return existing.execution;
      }
      return {
        ok: false,
        action,
        message: 'That prior Showtail claim is already being used by another control.',
      };
    }

    const completedKey = `${action}\0${priorClaimId}`;
    const completed = this.completedPriorClaims.get(completedKey);
    const replayable =
      completed !== undefined &&
      this.completedClaimBelongsToRequest(completed, options.requestIdentity);
    if (completed && !replayable) this.completedPriorClaims.delete(completedKey);

    const execution = replayable
      ? this.replayCompletedPriorClaim(action, completed, token)
      : this.executeOnce(action, selector, priorClaimId, token, options);
    this.inFlightPriorClaims.set(priorClaimId, {
      action,
      execution,
      ...(options.requestIdentity !== undefined
        ? { requestIdentity: options.requestIdentity }
        : {}),
    });
    try {
      const result = await execution;
      if (result.ok) {
        this.completedPriorClaims.set(completedKey, {
          execution: result,
          completedAt: Date.now(),
          ...(options.requestIdentity !== undefined
            ? { requestIdentity: options.requestIdentity }
            : {}),
        });
        while (this.completedPriorClaims.size > MAX_COMPLETED_PRIOR_CLAIMS) {
          const oldest = this.completedPriorClaims.keys().next().value;
          if (oldest === undefined) break;
          this.completedPriorClaims.delete(oldest);
        }
      }
      return result;
    } finally {
      if (this.inFlightPriorClaims.get(priorClaimId)?.execution === execution) {
        this.inFlightPriorClaims.delete(priorClaimId);
      }
    }
  }
}

function toolFailure(execution: Extract<ProjectControlExecution, { ok: false }>): string {
  const allCandidates = execution.resolution?.candidates ?? [];
  const candidates: Array<{ trailId: string; root: string; displayName: string }> = [];
  const base = {
    showtailProjectControl: SHOWTAIL_PROJECT_CONTROL_PROTOCOL,
    ok: false,
    action: execution.action,
    state: execution.resolution?.state,
    errorCode: execution.resolution?.errorCode
      ? truncateUtf8(execution.resolution.errorCode, 160)
      : undefined,
    message: truncateUtf8(execution.message, 2_400),
    candidateCount: allCandidates.length,
  };

  for (const candidate of allCandidates) {
    const next = {
      trailId: truncateUtf8(candidate.trailId, 200),
      root: truncateUtf8(candidate.root, 1_200),
      displayName: truncateUtf8(candidate.displayName, 240),
    };
    const tentative = JSON.stringify({
      ...base,
      candidates: [...candidates, next],
      candidatesTruncated: candidates.length + 1 < allCandidates.length,
    });
    if (utf8Length(tentative) > MAX_TOOL_OUTPUT_BYTES) break;
    candidates.push(next);
  }

  const payload = JSON.stringify({
    ...base,
    ...(candidates.length > 0 ? { candidates } : {}),
    candidatesTruncated: candidates.length < allCandidates.length,
  });
  if (utf8Length(payload) <= MAX_TOOL_OUTPUT_BYTES) return payload;

  // JSON escaping can expand control-heavy diagnostics beyond their raw UTF-8
  // size. Fall back to metadata-only output and fit the message by serialized size.
  const { message, ...metadata } = base;
  let low = 0;
  let high = message.length;
  let bounded = JSON.stringify({
    ...metadata,
    message: '',
    candidatesTruncated: allCandidates.length > 0,
  });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const proposed = JSON.stringify({
      ...metadata,
      message: message.slice(0, middle),
      candidatesTruncated: allCandidates.length > 0,
    });
    if (utf8Length(proposed) <= MAX_TOOL_OUTPUT_BYTES) {
      bounded = proposed;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return bounded;
}

export function projectControlToolResult(
  execution: ProjectControlExecution,
): vscode.LanguageModelToolResult {
  if (!execution.ok) {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(toolFailure(execution)),
    ]);
  }
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(execution.marker)),
    new vscode.LanguageModelTextPart(execution.text),
  ]);
}

export function registerProjectControlTool(
  context: vscode.ExtensionContext,
  controller: ProjectControlController,
  output: vscode.OutputChannel,
): void {
  if (typeof vscode.lm?.registerTool !== 'function') {
    output.appendLine(
      'Language model tools are unavailable here - native project control is disabled.',
    );
    return;
  }

  const tool: vscode.LanguageModelTool<ProjectControlInput> = {
    prepareInvocation(options) {
      const selector = cleanSelector(options.input.selector);
      const action = options.input.action.replace('_', ' ');
      return {
        invocationMessage: selector
          ? `Resolving ${selector} and running Showtail ${action}...`
          : `Choosing a project and running Showtail ${action}...`,
      };
    },
    async invoke(options, token) {
      return projectControlToolResult(
        await controller.execute(options.input, token, {
          selectorSource: 'semantic',
          requestIdentity: options.toolInvocationToken,
        }),
      );
    },
  };
  context.subscriptions.push(vscode.lm.registerTool('showtail_project_control', tool));
}
