import { lstatSync, realpathSync } from 'node:fs';
import { basename, posix, win32 } from 'node:path';

export const SHOWTAIL_VSCODE_HOOK_PROTOCOL = 'showtail-vscode-extension-hook/v1';
export const SHOWTAIL_PROJECT_CONTROL_PROTOCOL = 'showtail-project-control/v1';

export type ExtensionHookTool = 'github-copilot' | 'antigravity-ide';
export type ExtensionHookEvent =
  | 'session-start'
  | 'user-prompt'
  | 'post-edit'
  | 'stop'
  | 'session-end';

export function extensionHookArgs(
  tool: ExtensionHookTool,
  event: ExtensionHookEvent,
): string[] {
  return ['hook', event, '--tool', tool];
}

/** Read the durable machine-wide capture consent state without mutating a project. */
export function captureStatusArgs(tool: ExtensionHookTool): string[] {
  return ['status', '--json', '--tool', tool];
}

export function copilotImportArgs(file: string): string[] {
  return ['import', 'copilot', '--file', file, '--auto', '--quiet'];
}

/** Refresh project instructions without treating the editor as an explicit reconnect. */
export function copilotManagedRefreshArgs(force = false): string[] {
  return [
    'connect',
    'copilot',
    '--no-extension',
    '--managed-refresh',
    ...(force ? ['--force'] : []),
  ];
}

export function projectsArgs(selector?: string): string[] {
  return ['projects', ...(selector?.trim() ? [selector.trim()] : []), '--json'];
}

export function reportArgs(projectSelector: string): string[] {
  return ['report', '--project', projectSelector, '--json', '--no-open'];
}

export function verifyArgs(projectSelector: string): string[] {
  return ['verify', '--project', projectSelector, '--json'];
}

export function statusArgs(projectSelector: string, tool: ExtensionHookTool): string[] {
  return ['status', '--project', projectSelector, '--json', '--tool', tool];
}

export interface AssistantCapture {
  text: string;
  sourceId: string;
  model?: string;
}

export interface ExtensionHookContext {
  projectCwd: string | null;
  cwd: string;
  workspacePaths: string[];
}

export interface ExtensionHookPayload {
  showtailExtension: typeof SHOWTAIL_VSCODE_HOOK_PROTOCOL;
  session_id: string;
  projectCwd: string | null;
  cwd: string;
  workspacePaths: string[];
  timestamp: string;
  prompt?: string;
  editedFiles?: string[];
  assistant?: AssistantCapture;
}

export interface HookPayloadInput extends ExtensionHookContext {
  sessionId: string;
  prompt?: string;
  editedFiles?: string[];
  assistant?: AssistantCapture;
  timestamp?: string;
}

export function extensionHookPayload(input: HookPayloadInput): ExtensionHookPayload {
  return {
    showtailExtension: SHOWTAIL_VSCODE_HOOK_PROTOCOL,
    session_id: input.sessionId,
    projectCwd: input.projectCwd,
    cwd: input.cwd,
    workspacePaths: input.workspacePaths,
    timestamp: input.timestamp ?? new Date().toISOString(),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.editedFiles !== undefined ? { editedFiles: input.editedFiles } : {}),
    ...(input.assistant !== undefined ? { assistant: input.assistant } : {}),
  };
}

export function chatSessionId(file: string): string {
  return basename(file).replace(/\.jsonl?$/i, '');
}

/** Commands that operate on project-local trail data need an explicit project. */
export function chatCommandRequiresProject(command: string | undefined): boolean {
  return (
    command === 'report' ||
    command === 'open_report' ||
    command === 'verify' ||
    command === 'trace'
  );
}

export type OptionalProjectPath =
  | { ok: true; path?: string }
  | { ok: false; message: string };

export type SelectedProjectPath =
  | { ok: true; path?: string; explicit: boolean }
  | { ok: false; message: string };

interface PathApi {
  basename(value: string): string;
  dirname(value: string): string;
  isAbsolute(value: string): boolean;
  join(...paths: string[]): string;
  normalize(value: string): string;
  relative(from: string, to: string): string;
  sep: string;
}

interface AbsolutePath {
  value: string;
  api: PathApi;
  windows: boolean;
}

function absolutePath(value: string): AbsolutePath | null {
  if (typeof value !== 'string') return null;
  // Drive-qualified and UNC paths must be recognized even when tests run on POSIX.
  const isWindows = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value);
  const api: PathApi = isWindows ? win32 : posix;
  if (!api.isAbsolute(value)) return null;
  return { value: api.normalize(value), api, windows: isWindows };
}

function lexicalPathIsWithin(root: AbsolutePath, candidate: AbsolutePath): boolean {
  if (root.windows !== candidate.windows) return false;
  const from = root.windows ? root.value.toLocaleLowerCase('en-US') : root.value;
  const to = candidate.windows
    ? candidate.value.toLocaleLowerCase('en-US')
    : candidate.value;
  const relative = root.api.relative(from, to);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${root.api.sep}`) &&
      !root.api.isAbsolute(relative))
  );
}

function existingRealPath(value: AbsolutePath): AbsolutePath | null {
  const nativeWindows = process.platform === 'win32';
  if (value.windows !== nativeWindows) return null;
  try {
    return absolutePath(realpathSync.native(value.value));
  } catch {
    return null;
  }
}

function realPath(value: AbsolutePath): AbsolutePath {
  return existingRealPath(value) ?? value;
}

function nearestExistingRealPath(value: AbsolutePath): AbsolutePath | null {
  const nativeWindows = process.platform === 'win32';
  if (value.windows !== nativeWindows) return null;
  let candidate = value.value;
  while (true) {
    try {
      return absolutePath(realpathSync.native(candidate));
    } catch {
      try {
        lstatSync(candidate);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      const parent = value.api.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

function pathIsWithin(root: AbsolutePath, candidate: AbsolutePath): boolean {
  const lexical = lexicalPathIsWithin(root, candidate);
  const realRoot = existingRealPath(root);
  if (!realRoot) return lexical;
  const realCandidateParent = nearestExistingRealPath(candidate);
  return realCandidateParent ? lexicalPathIsWithin(realRoot, realCandidateParent) : false;
}

function pathsAreEqual(left: AbsolutePath, right: AbsolutePath): boolean {
  if (lexicalPathIsWithin(left, right) && lexicalPathIsWithin(right, left)) {
    return true;
  }
  const realLeft = realPath(left);
  const realRight = realPath(right);
  return (
    lexicalPathIsWithin(realLeft, realRight) && lexicalPathIsWithin(realRight, realLeft)
  );
}

/** Parse one optional absolute folder without invoking a shell or interpreting backslashes. */
export function parseOptionalProjectPath(prompt: string): OptionalProjectPath {
  const input = prompt.trim();
  if (!input) return { ok: true };
  if (input.includes('\0')) {
    return {
      ok: false,
      message: 'The project folder contains an invalid null character.',
    };
  }

  let value = input;
  const quote = input[0];
  if (quote === '"' || quote === "'") {
    const closing = input.lastIndexOf(quote);
    if (closing === 0 || input.slice(closing + 1).trim().length > 0) {
      return {
        ok: false,
        message: 'Pass one absolute project folder; close its surrounding quotes.',
      };
    }
    value = input.slice(1, closing);
    if (value.includes(quote)) {
      return {
        ok: false,
        message: 'Pass one absolute project folder without nested quote characters.',
      };
    }
  } else if (input.includes('"') || input.startsWith("'") || input.endsWith("'")) {
    return {
      ok: false,
      message: 'Pass one absolute project folder; quote the complete path if needed.',
    };
  }

  const parsed = absolutePath(value);
  if (!parsed) {
    return {
      ok: false,
      message:
        'Pass an absolute project folder, for example `@showtail /report "C:\\Users\\student\\my game"`.',
    };
  }
  return { ok: true, path: parsed.value };
}

/** Prefer an explicit slash-command target over the editor's implicit project. */
export function selectProjectPath(
  prompt: string,
  implicitProject?: string,
): SelectedProjectPath {
  const requested = parseOptionalProjectPath(prompt);
  if (!requested.ok) return requested;
  if (requested.path) return { ok: true, path: requested.path, explicit: true };
  if (!implicitProject) return { ok: true, explicit: false };
  const fallback = absolutePath(implicitProject);
  return fallback
    ? { ok: true, path: fallback.value, explicit: false }
    : { ok: false, message: 'The editor returned an invalid project folder.' };
}

/** Re-open the save ledger after an Antigravity transcript creates its trail. */
export function antigravitySaveReconcileInput(
  sessionId: string,
  context: ExtensionHookContext | undefined,
): HookPayloadInput | undefined {
  return context ? { sessionId, ...context } : undefined;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProjectControlAction = 'report' | 'open_report' | 'status' | 'verify';
export type ProjectResolutionState =
  | 'selected'
  | 'confirmation-required'
  | 'ambiguous'
  | 'conflict'
  | 'not-found';
export type ProjectSelectionMode = 'authoritative' | 'corroborated';

export interface ProjectSelection {
  trailId: string;
  root: string;
  displayName: string;
  mode: ProjectSelectionMode;
  evidence: string[];
  crossWorkspace?: boolean;
}

export interface ProjectResolution {
  schemaVersion: 1;
  state: ProjectResolutionState;
  selector?: string;
  selection?: ProjectSelection;
  candidates: ProjectSelection[];
  message?: string;
  errorCode?: string;
}

export interface ProjectControlMarker {
  showtailProjectControl: typeof SHOWTAIL_PROJECT_CONTROL_PROTOCOL;
  claimId: string;
  action: ProjectControlAction;
  trailId: string;
  root: string;
  displayName?: string;
  mode: ProjectSelectionMode;
  evidence: string[];
  crossWorkspace?: boolean;
  reportPath?: string;
}

export interface StoredProjectControlClaim extends ProjectControlMarker {
  createdAt: string;
}

export type CaptureConsent = 'enabled' | 'disabled' | 'unknown';

/** Parse the read-only tool status without letting errors enable background work. */
export function captureConsentFromStatus(result: CliResult): CaptureConsent {
  if (result.exitCode !== 0) return 'unknown';
  try {
    const status = JSON.parse(result.stdout);
    if (status.captureGloballyDisabled === true) return 'disabled';
    if (status.captureGloballyDisabled === false) return 'enabled';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A background import only counts as captured while consent still remains on. */
export function automaticCaptureSucceeded(
  result: CliResult,
  consentAfter: CaptureConsent,
): boolean {
  return result.exitCode === 0 && consentAfter === 'enabled';
}

/** A managed refresh counts only when its file exists and consent stayed enabled. */
export function managedRefreshSucceeded(
  result: CliResult,
  sentinelPresent: boolean,
  consentAfter: CaptureConsent,
): boolean {
  return result.exitCode === 0 && sentinelPresent && consentAfter === 'enabled';
}

export interface RelocatedSession {
  id: string;
  from: string;
  to: string;
  tier: 'A';
  detail: string;
}

export interface RelocationCandidate {
  id: string;
  from: string;
  to: string;
  tier: 'A' | 'B';
  detail: string;
  reason: 'similarity' | 'mixed' | 'unsafe-rebase';
}

export interface PendingRange {
  id: string;
  sessionId?: string;
  rangeId?: string;
  startedAt?: string;
  lastSeenAt?: string;
  firstPrompt?: string | null;
  lastPrompt?: string | null;
  prompts?: number;
  edits?: number;
  reason?: string;
  candidates: string[];
}

interface ReportDetails {
  relocatedSessions?: RelocatedSession[];
  relocationCandidates?: RelocationCandidate[];
  pendingRanges?: PendingRange[];
  pendingRangeCount?: number;
  errorCode?: string;
  nextAction?: string;
}

export type ReportResult =
  | ({ ok: true; root: string; path: string; trailId?: string } & ReportDetails)
  | ({ ok: false; message: string } & ReportDetails);

export interface ProjectCommandResult {
  ok: boolean;
  payload: Record<string, unknown> | null;
  text: string;
  trailId?: string;
  root?: string;
  pendingRanges?: PendingRange[];
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeIdentifier(value: unknown): string | null {
  const parsed = nonEmptyString(value);
  return parsed && !/[\r\n\0]/.test(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = nonEmptyString(item);
    return parsed ? [parsed] : [];
  });
}

function projectEvidence(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const parsed: string[] = [];
  for (const item of value) {
    const evidence = nonEmptyString(item);
    if (!evidence || evidence.length > 80 || /[\0\r\n]/.test(evidence)) return null;
    parsed.push(evidence);
  }
  return [...new Set(parsed)];
}

function relocationObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function projectSelection(
  value: unknown,
  requireMetadata = false,
): ProjectSelection | null {
  const item = relocationObject(value);
  if (!item) return null;
  const trailId = safeIdentifier(item.trailId);
  const root = nonEmptyString(item.root);
  const parsedRoot = root ? absolutePath(root) : null;
  if (
    !trailId ||
    !parsedRoot ||
    (requireMetadata && !/^trl_[A-Za-z0-9_-]+$/.test(trailId)) ||
    (requireMetadata &&
      item.crossWorkspace !== undefined &&
      typeof item.crossWorkspace !== 'boolean')
  ) {
    return null;
  }
  const displayName =
    nonEmptyString(item.displayName) ?? parsedRoot.api.basename(parsedRoot.value);
  if (!displayName) return null;
  const mode: ProjectSelectionMode | null =
    item.mode === 'authoritative' || item.mode === 'corroborated'
      ? item.mode
      : requireMetadata
        ? null
        : 'corroborated';
  const evidence = requireMetadata
    ? projectEvidence(item.evidence)
    : stringArray(item.evidence);
  if (!mode || !evidence) return null;
  return {
    trailId,
    root: parsedRoot.value,
    displayName,
    mode,
    evidence,
    ...(item.crossWorkspace === true ? { crossWorkspace: true } : {}),
  };
}

/** Parse the compact project catalog/resolution response without trusting loose paths. */
export function parseProjectResolution(result: CliResult): ProjectResolution {
  const payload = jsonObject(result.stdout.trim());
  if (!payload) {
    const detail = [result.stderr, result.stdout]
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    return {
      schemaVersion: 1,
      state: 'not-found',
      candidates: [],
      message: detail ?? 'Showtail did not return a valid project resolution.',
    };
  }
  if (result.exitCode !== 0) {
    const detail =
      nonEmptyString(payload.message) ??
      [result.stderr, result.stdout]
        .map((value) => value.trim())
        .find((value) => value.length > 0);
    return {
      schemaVersion: 1,
      state: 'not-found',
      candidates: [],
      message: detail ?? 'Showtail could not resolve a project.',
    };
  }
  if (payload.schemaVersion !== 1) {
    return {
      schemaVersion: 1,
      state: 'not-found',
      candidates: [],
      message: 'Showtail returned an unsupported project-resolution version.',
    };
  }

  const rawState = payload.state;
  const catalog = rawState === 'catalog';
  const state: ProjectResolutionState =
    rawState === 'selected' ||
    rawState === 'confirmation-required' ||
    rawState === 'ambiguous' ||
    rawState === 'conflict' ||
    rawState === 'not-found'
      ? rawState
      : 'not-found';
  const selection = projectSelection(payload.selection, state === 'selected');
  const candidateSource = Array.isArray(payload.candidates)
    ? payload.candidates
    : Array.isArray(payload.projects)
      ? payload.projects
      : [];
  const candidates = candidateSource.flatMap((candidate) => {
    const parsed = projectSelection(candidate);
    return parsed ? [parsed] : [];
  });
  if (selection && state !== 'selected' && candidates.length === 0) {
    candidates.push(selection);
  }
  const selector = nonEmptyString(payload.selector) ?? undefined;
  const message = nonEmptyString(payload.message) ?? undefined;
  const errorCode = safeIdentifier(payload.errorCode) ?? undefined;

  if (state === 'selected' && !selection) {
    return {
      schemaVersion: 1,
      state: 'not-found',
      ...(selector ? { selector } : {}),
      candidates,
      message: 'Showtail selected a project without returning a valid trail identity.',
      ...(errorCode ? { errorCode } : {}),
    };
  }

  return {
    schemaVersion: 1,
    state:
      (rawState === undefined || catalog) && candidates.length > 0 ? 'ambiguous' : state,
    ...(selector ? { selector } : {}),
    ...(selection ? { selection } : {}),
    candidates,
    ...(message ? { message } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return nonEmptyString(value) ?? undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function pendingRange(value: unknown): PendingRange | null {
  const item = relocationObject(value);
  if (!item) return null;
  const id = nonEmptyString(item.id);
  if (!id) return null;
  const sessionId = nonEmptyString(item.sessionId) ?? undefined;
  const rangeId = nonEmptyString(item.rangeId) ?? undefined;
  const startedAt = nonEmptyString(item.startedAt) ?? undefined;
  const lastSeenAt = nonEmptyString(item.lastSeenAt) ?? undefined;
  const firstPrompt = nullableString(item.firstPrompt);
  const lastPrompt = nullableString(item.lastPrompt);
  const prompts = count(item.prompts);
  const edits = count(item.edits);
  const reason = nonEmptyString(item.reason) ?? undefined;
  const candidates = Array.isArray(item.candidates)
    ? item.candidates.flatMap((candidate) => {
        const parsed = nonEmptyString(candidate);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    id,
    ...(sessionId ? { sessionId } : {}),
    ...(rangeId ? { rangeId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    ...(lastPrompt !== undefined ? { lastPrompt } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
    ...(edits !== undefined ? { edits } : {}),
    ...(reason ? { reason } : {}),
    candidates,
  };
}

function relocatedSession(value: unknown): RelocatedSession | null {
  const item = relocationObject(value);
  if (!item) return null;
  const id = nonEmptyString(item.id);
  const from = nonEmptyString(item.from);
  const to = nonEmptyString(item.to);
  const detail = nonEmptyString(item.detail);
  if (!id || !from || !to || item.tier !== 'A' || !detail) {
    return null;
  }
  return { id, from, to, tier: 'A', detail };
}

function relocationCandidate(value: unknown): RelocationCandidate | null {
  const item = relocationObject(value);
  if (!item) return null;
  const id = nonEmptyString(item.id);
  const from = nonEmptyString(item.from);
  const to = nonEmptyString(item.to);
  const detail = nonEmptyString(item.detail);
  const tier = item.tier === 'A' || item.tier === 'B' ? item.tier : null;
  const reason =
    item.reason === 'similarity' ||
    item.reason === 'mixed' ||
    item.reason === 'unsafe-rebase'
      ? item.reason
      : null;
  if (!id || !from || !to || !tier || !detail || !reason) {
    return null;
  }
  return { id, from, to, tier, detail, reason };
}

function parsedArray<T>(
  value: unknown,
  parse: (item: unknown) => T | null,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed ? [parsed] : [];
  });
}

function reportDetails(payload: Record<string, unknown> | null): ReportDetails {
  if (!payload) return {};
  const nested = relocationObject(payload.details);
  const relocatedSessions = parsedArray(
    payload.relocatedSessions ?? nested?.relocatedSessions,
    relocatedSession,
  );
  const relocationCandidates = parsedArray(
    payload.relocationCandidates ?? nested?.relocationCandidates,
    relocationCandidate,
  );
  const pendingRanges = parsedArray(
    payload.pendingRanges ?? nested?.pendingRanges,
    pendingRange,
  );
  const routing = relocationObject(payload.routing ?? nested?.routing);
  const pendingRangeCount =
    count(routing?.pendingRanges) ??
    (pendingRanges !== undefined ? pendingRanges.length : undefined);
  const errorCode = nonEmptyString(payload.errorCode);
  const nextAction = nonEmptyString(payload.nextAction);
  const isRelocationReview =
    errorCode === 'RELOCATION_REVIEW_REQUIRED' || relocationCandidates !== undefined;
  return {
    ...(relocatedSessions !== undefined ? { relocatedSessions } : {}),
    ...(relocationCandidates !== undefined ? { relocationCandidates } : {}),
    ...(pendingRanges !== undefined ? { pendingRanges } : {}),
    ...(pendingRangeCount !== undefined ? { pendingRangeCount } : {}),
    ...(isRelocationReview && errorCode ? { errorCode } : {}),
    ...(isRelocationReview && nextAction ? { nextAction } : {}),
  };
}

function payloadWithoutPendingRanges(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const display = { ...payload };
  delete display.pendingRanges;
  const nested = relocationObject(display.details);
  if (nested && 'pendingRanges' in nested) {
    const details = { ...nested };
    delete details.pendingRanges;
    display.details = details;
  }
  return display;
}

function stripTerminalLinks(value: string): string {
  return value
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '')
    .replace(/\x1b\]8;;\x07/g, '')
    .trim();
}

function validatedReportPaths(
  selectedProject: string,
  returnedRoot: unknown,
  returnedPath: string,
  options: ReportValidationOptions,
): { root: string; path: string } | { message: string } {
  const selected = absolutePath(selectedProject);
  if (!selected) {
    return { message: 'Showtail was given an invalid project folder.' };
  }
  const rootText = nonEmptyString(returnedRoot);
  const root = rootText ? absolutePath(rootText) : selected;
  if (!root) {
    return {
      message: 'Showtail returned an invalid project root. No report was opened.',
    };
  }
  if (options.exactRoot && !pathsAreEqual(root, selected)) {
    return {
      message:
        `Showtail resolved ${root.value}, not the explicitly selected project ` +
        `${selected.value}. Pass the actual project root and try again; no report was opened.`,
    };
  }
  const disallowedAncestor = (options.disallowedAncestorRoots ?? []).some((value) => {
    const disallowed = absolutePath(value);
    return disallowed
      ? pathsAreEqual(root, disallowed) && !pathsAreEqual(root, selected)
      : false;
  });
  if (disallowedAncestor) {
    return {
      message:
        `Showtail resolved the broad home folder ${root.value}, not the project ` +
        `${selected.value}. Select the actual project root and try again; no report was opened.`,
    };
  }
  if (!pathIsWithin(root, selected)) {
    return {
      message:
        `Showtail returned a report for ${root.value}, not the selected project ` +
        `${selected.value}. No report was opened.`,
    };
  }
  const reportPath = absolutePath(returnedPath);
  if (!reportPath || !pathIsWithin(root, reportPath)) {
    return {
      message:
        'Showtail returned a report path outside the selected project. No report was opened.',
    };
  }
  return { root: root.value, path: reportPath.value };
}

export interface ReportValidationOptions {
  /** Explicit slash-command paths must identify the canonical project root exactly. */
  exactRoot?: boolean;
  /** Catch-all roots such as HOME must not win merely because they contain the project. */
  disallowedAncestorRoots?: string[];
  /** Project-control calls require the CLI to echo the exact stable identity selected. */
  expectedTrailId?: string;
}

/** Read report output and refuse paths that do not belong to the selected project. */
export function parseReportResult(
  result: CliResult,
  selectedProject: string,
  options: ReportValidationOptions = {},
): ReportResult {
  const payload = jsonObject(result.stdout.trim());
  const details = reportDetails(payload);
  if (result.exitCode === 0) {
    const returnedTrailId = safeIdentifier(payload?.trailId);
    if (
      options.expectedTrailId &&
      (!returnedTrailId || returnedTrailId !== options.expectedTrailId)
    ) {
      return {
        ok: false,
        message: returnedTrailId
          ? `Showtail returned trail ${returnedTrailId}, not the selected trail ${options.expectedTrailId}. No report was opened.`
          : 'Showtail did not identify the trail used for this report. No report was opened.',
        ...details,
      };
    }
    const reportPath = payload?.reportPath;
    if (typeof reportPath === 'string' && reportPath.trim().length > 0) {
      const validated = validatedReportPaths(
        selectedProject,
        payload?.root,
        reportPath.trim(),
        options,
      );
      return 'message' in validated
        ? { ok: false, message: validated.message, ...details }
        : {
            ok: true,
            ...validated,
            ...(returnedTrailId ? { trailId: returnedTrailId } : {}),
            ...details,
          };
    }
    const match = result.stdout.match(/Wrote (?:JSON )?report \([^)]+\):\s*(.+?)\s*$/m);
    if (match?.[1]) {
      const validated = validatedReportPaths(
        selectedProject,
        undefined,
        stripTerminalLinks(match[1]),
        options,
      );
      return 'message' in validated
        ? { ok: false, message: validated.message, ...details }
        : {
            ok: true,
            ...validated,
            ...(returnedTrailId ? { trailId: returnedTrailId } : {}),
            ...details,
          };
    }
    return {
      ok: false,
      message:
        'Showtail finished without returning a report path. Check the Showtail output.',
      ...details,
    };
  }

  const structuredMessage = payload?.message;
  if (typeof structuredMessage === 'string' && structuredMessage.trim().length > 0) {
    return { ok: false, message: structuredMessage.trim(), ...details };
  }
  const detail = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (detail) return { ok: false, message: detail, ...details };
  if (result.exitCode === 2) {
    return {
      ok: false,
      message:
        'Showtail could not select one project. Review the Showtail inbox and try again.',
      ...details,
    };
  }
  if (result.exitCode === 4) {
    return {
      ok: false,
      message:
        'No captured work matches this project yet. Keep working, then try the report again.',
      ...details,
    };
  }
  return {
    ok: false,
    message: 'Showtail could not generate the report.',
    ...details,
  };
}

/** Parse JSON controls such as status/verify while keeping pending inbox ranges typed. */
export function parseProjectCommandResult(result: CliResult): ProjectCommandResult {
  const payload = jsonObject(result.stdout.trim());
  const pendingRanges = reportDetails(payload).pendingRanges;
  if (payload) {
    const display = payloadWithoutPendingRanges(payload);
    return {
      ok: result.exitCode === 0,
      payload,
      text:
        result.exitCode === 0
          ? JSON.stringify(display, null, 2)
          : (nonEmptyString(payload.message) ?? JSON.stringify(display, null, 2)),
      ...(pendingRanges !== undefined ? { pendingRanges } : {}),
    };
  }
  const text = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return {
    ok: result.exitCode === 0,
    payload: null,
    text:
      text ??
      (result.exitCode === 0 ? 'Showtail finished successfully.' : 'Showtail failed.'),
  };
}

/** Require status/verify to echo the identity that was resolved immediately before it. */
export function parseResolvedProjectCommandResult(
  result: CliResult,
  selection: ProjectSelection,
): ProjectCommandResult {
  const parsed = parseProjectCommandResult(result);
  if (!parsed.ok || !parsed.payload) return parsed;
  const trailId = safeIdentifier(parsed.payload.trailId);
  const rootText = nonEmptyString(parsed.payload.root);
  const expectedRoot = absolutePath(selection.root);
  const root = rootText ? absolutePath(rootText) : null;
  if (!trailId || trailId !== selection.trailId) {
    return {
      ...parsed,
      ok: false,
      text: trailId
        ? `Showtail returned trail ${trailId}, not the selected trail ${selection.trailId}.`
        : 'Showtail did not identify the trail used for this command.',
    };
  }
  if (!root || !expectedRoot || !pathsAreEqual(root, expectedRoot)) {
    return {
      ...parsed,
      ok: false,
      text: root
        ? `Showtail returned project ${root.value}, not the selected project ${selection.root}.`
        : 'Showtail did not return a valid project root for this command.',
    };
  }
  return { ...parsed, trailId, root: root.value };
}

export function createProjectControlMarker(
  claimId: string,
  action: ProjectControlAction,
  selection: ProjectSelection,
  reportPath?: string,
): ProjectControlMarker {
  return {
    showtailProjectControl: SHOWTAIL_PROJECT_CONTROL_PROTOCOL,
    claimId,
    action,
    trailId: selection.trailId,
    root: selection.root,
    displayName: selection.displayName,
    mode: selection.mode,
    evidence: selection.evidence,
    ...(selection.crossWorkspace ? { crossWorkspace: true } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

/** Validate only the versioned marker emitted by Showtail's registered LM tool. */
export function parseProjectControlMarker(value: unknown): ProjectControlMarker | null {
  const item = relocationObject(value);
  if (
    !item ||
    item.showtailProjectControl !== SHOWTAIL_PROJECT_CONTROL_PROTOCOL ||
    (item.action !== 'report' &&
      item.action !== 'open_report' &&
      item.action !== 'status' &&
      item.action !== 'verify')
  ) {
    return null;
  }
  const claimId = safeIdentifier(item.claimId);
  const selection = projectSelection(item, true);
  if (!claimId || claimId.length > 200 || !selection) return null;

  const reportPath = nonEmptyString(item.reportPath) ?? undefined;
  if (reportPath) {
    const root = absolutePath(selection.root);
    const report = absolutePath(reportPath);
    if (!root || !report || !pathIsWithin(root, report)) return null;
  }
  return createProjectControlMarker(claimId, item.action, selection, reportPath);
}

/** Return the newest valid report-bearing claim from oldest-to-newest history. */
export function latestReportProjectControlClaimId(
  markers: readonly unknown[],
): string | undefined {
  for (const value of [...markers].reverse()) {
    const marker = parseProjectControlMarker(value);
    if (
      marker?.reportPath &&
      (marker.action === 'report' || marker.action === 'open_report')
    ) {
      return marker.claimId;
    }
  }
  return undefined;
}

/** Return the newest valid project-control claim, regardless of action. */
export function latestProjectControlClaimId(
  markers: readonly unknown[],
): string | undefined {
  for (const value of [...markers].reverse()) {
    const marker = parseProjectControlMarker(value);
    if (marker) return marker.claimId;
  }
  return undefined;
}

function storedProjectControlClaim(value: unknown): StoredProjectControlClaim | null {
  const item = relocationObject(value);
  const marker = parseProjectControlMarker(value);
  const createdAt = nonEmptyString(item?.createdAt);
  if (!marker || !createdAt || !Number.isFinite(Date.parse(createdAt))) {
    return null;
  }
  return {
    ...marker,
    createdAt,
  };
}

/** Read only recent, structurally valid claims from extension global state. */
export function parseStoredProjectControlClaims(
  value: unknown,
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): StoredProjectControlClaim[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = storedProjectControlClaim(item);
    if (!parsed) return [];
    const created = Date.parse(parsed.createdAt);
    return created <= now + 5 * 60 * 1000 && now - created <= maxAgeMs ? [parsed] : [];
  });
}

/** Rebase a validated report claim when the same trail has moved to a new root. */
export function reportPathFromClaim(
  claim: StoredProjectControlClaim,
  selection: ProjectSelection,
): string | undefined {
  if (claim.trailId !== selection.trailId || !claim.reportPath) return undefined;
  const oldRoot = absolutePath(claim.root);
  const oldReport = absolutePath(claim.reportPath);
  const newRoot = absolutePath(selection.root);
  if (
    !oldRoot ||
    !oldReport ||
    !newRoot ||
    oldRoot.windows !== oldReport.windows ||
    oldRoot.windows !== newRoot.windows ||
    !pathIsWithin(oldRoot, oldReport)
  ) {
    return undefined;
  }
  const relative = oldRoot.api.relative(oldRoot.value, oldReport.value);
  const rebased = absolutePath(newRoot.api.join(newRoot.value, relative));
  return rebased && pathIsWithin(newRoot, rebased) ? rebased.value : undefined;
}

function markdownCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fencedCode(value: string, language = ''): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

/** Explain unresolved ledger ranges without making an otherwise valid report fail. */
export function pendingRangesMarkdown(ranges: PendingRange[]): string | undefined {
  if (ranges.length === 0) return undefined;
  const noun = ranges.length === 1 ? 'range remains' : 'ranges remain';
  return [
    `${ranges.length} captured work ${noun} in the Showtail inbox:`,
    ...ranges.map((range) => {
      const reason = inlineText(range.reason ?? 'project not resolved');
      const candidates =
        range.candidates.length > 0
          ? `; candidates: ${range.candidates.map(markdownCode).join(', ')}`
          : '; no unique project candidate';
      return `- ${markdownCode(range.id)}: ${reason}${candidates}`;
    }),
    '',
    'Run `showtail inbox` to review or place them.',
  ].join('\n');
}

export function pendingRangesNotice(ranges: PendingRange[]): string | undefined {
  if (ranges.length === 0) return undefined;
  const noun = ranges.length === 1 ? 'range still needs' : 'ranges still need';
  return `${ranges.length} captured work ${noun} placement. Run showtail inbox.`;
}

function recoverySummary(
  sessions: RelocatedSession[],
  formatPath: (value: string) => string,
): string | null {
  if (sessions.length === 0) return null;
  const from = [...new Set(sessions.map((session) => session.from))];
  const noun = sessions.length === 1 ? 'session' : 'sessions';
  return `Recovered ${sessions.length} moved ${noun} from ${from.map(formatPath).join(', ')}.`;
}

function reviewReason(reason: RelocationCandidate['reason']): string {
  if (reason === 'similarity') return 'similar content only';
  if (reason === 'mixed') return 'some original files still exist';
  return 'the whole session cannot be safely rebased';
}

/** Format report output for the chat surface without losing structured review detail. */
export function reportResultMarkdown(result: ReportResult): string {
  const sections: string[] = [];
  if (result.ok) {
    const recovered = recoverySummary(result.relocatedSessions ?? [], markdownCode);
    if (recovered) sections.push(recovered);
    sections.push(`Report written to ${markdownCode(result.path)}.`);
  } else {
    sections.push(result.message);
    const candidates = result.relocationCandidates ?? [];
    if (candidates.length > 0) {
      const noun = candidates.length === 1 ? 'session needs' : 'sessions need';
      sections.push(
        [
          `${candidates.length} moved ${noun} review:`,
          ...candidates.map(
            (candidate) =>
              `- ${markdownCode(candidate.id)}: ${reviewReason(candidate.reason)} from ${markdownCode(candidate.from)} ` +
              `to ${markdownCode(candidate.to)} - ${candidate.detail}`,
          ),
        ].join('\n'),
      );
    }
  }
  const pending = pendingRangesMarkdown(result.pendingRanges ?? []);
  if (pending) sections.push(pending);
  return sections.join('\n\n');
}

/** Format status/verify JSON plus any unresolved-range guidance for chat. */
export function projectCommandResultMarkdown(result: ProjectCommandResult): string {
  const isJson = result.payload !== null && result.text.trimStart().startsWith('{');
  const sections = [isJson ? fencedCode(result.text, 'json') : result.text];
  const pending = pendingRangesMarkdown(result.pendingRanges ?? []);
  if (pending) sections.push(pending);
  return sections.join('\n\n');
}

/** Short plain-text notice for the command-palette report flow. */
export function reportRecoveryNotice(result: ReportResult): string | undefined {
  if (!result.ok) return undefined;
  return recoverySummary(result.relocatedSessions ?? [], (value) => value) ?? undefined;
}
