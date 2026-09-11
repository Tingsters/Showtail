/**
 * Guarded cleanup for an automatically-created trail whose originating ledger
 * session was subsequently routed somewhere better. Deletion is deliberately
 * conservative: any unrecognized or unreadable state leaves the trail alone.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  type Dirent,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { CaptureInterruptedError, requireCaptureContinuation } from './captureGuard.ts';
import { ledgerDir } from './globalConfig.ts';
import { CONFIG_VERSION, pathKey, SHOWTAIL_DIR } from './storage.ts';

const execFileAsync = promisify(execFile);
const QUARANTINE_SETTLE_MS = 20;
const GIT_LOCK_POLL_MS = 5;
const GIT_LOCK_QUIET_MS = 20;
const GIT_LOCK_WAIT_MS = 500;

const GITATTRIBUTES = `# Showtail stores content-addressed objects; keep bytes byte-exact.
* -text
`;

const GITIGNORE = `state.json
reports/
diag/

# Keep journal segments committable even when the project ignores *.log.
!authors/**/journal/**/*.log
`;

const PROJECT_EVIDENCE = new Set([
  'trail',
  'git',
  'marker',
  'workspace',
  'edit',
  'tool',
  'attachment',
  'control',
  'cwd',
  'explicit',
]);

export type ProvisionalTrailPruneReason =
  | 'pruned'
  | 'trail-not-found'
  | 'unsafe-root'
  | 'config-unreadable'
  | 'not-automatic'
  | 'ledger-session-mismatch'
  | 'config-modified'
  | 'git-state-unknown'
  | 'git-tracked'
  | 'ledger-state-unknown'
  | 'other-ledger-placement'
  | 'report-present'
  | 'unknown-file'
  | 'unrelated-trail-data'
  | 'trail-changed-during-check'
  | 'delete-failed';

export interface ProvisionalTrailPruneOptions {
  /** Directory containing the provisional `.showtail/`. */
  root: string;
  /** Ledger session that config claims caused automatic initialization. */
  ledgerSessionId: string;
  /** Automatic callers abort when their original capture-consent epoch changes. */
  continueCapture?: () => boolean;
  /** @internal Test-only seams for deterministic races around the prune claim. */
  testHooks?: {
    beforeClaim?: () => void | Promise<void>;
    onGitIndexLock?: () => void | Promise<void>;
  };
}

export interface ProvisionalTrailPruneResult {
  pruned: boolean;
  reason: ProvisionalTrailPruneReason;
  /** Present after config was read successfully. */
  trailId?: string;
  /** Stable diagnostic detail suitable for hook traces and tests. */
  detail?: string;
}

interface AutomaticConfig {
  version?: unknown;
  createdAt?: unknown;
  anchor?: unknown;
  anchorKind?: unknown;
  trailId?: unknown;
  initialization?: unknown;
  settings?: unknown;
  [key: string]: unknown;
}

interface LedgerSessionShape {
  id?: unknown;
  tool?: unknown;
  nativeSessionId?: unknown;
  targets?: unknown;
}

interface LedgerTargetShape {
  trailId?: unknown;
  path?: unknown;
}

interface TrailScan {
  repoSessionIds: Set<string>;
  eventIds: Set<string>;
  authorSlug?: string;
}

interface Refusal {
  reason: Exclude<ProvisionalTrailPruneReason, 'pruned'>;
  detail?: string;
}

interface LedgerCheck {
  creator: {
    nativeSessionId: string;
    tool?: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function strictJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function refusal(
  reason: Exclude<ProvisionalTrailPruneReason, 'pruned'>,
  detail?: string,
): Refusal {
  return detail === undefined ? { reason } : { reason, detail };
}

function validateConfig(
  raw: unknown,
  root: string,
  ledgerSessionId: string,
): { trailId: string } | Refusal {
  if (!isObject(raw)) return refusal('config-unreadable');
  const config = raw as AutomaticConfig;
  if (
    !hasOnlyKeys(
      config,
      new Set([
        'version',
        'createdAt',
        'anchor',
        'anchorKind',
        'trailId',
        'initialization',
        'settings',
      ]),
    )
  ) {
    return refusal('config-modified', 'unexpected config field');
  }

  if (!isObject(config.initialization)) return refusal('not-automatic');
  const initialization = config.initialization;
  if (initialization.mode !== 'automatic') return refusal('not-automatic');
  if (initialization.ledgerSessionId !== ledgerSessionId) {
    return refusal('ledger-session-mismatch');
  }
  if (
    !hasOnlyKeys(initialization, new Set(['mode', 'evidence', 'ledgerSessionId'])) ||
    typeof initialization.evidence !== 'string' ||
    !PROJECT_EVIDENCE.has(initialization.evidence)
  ) {
    return refusal('config-modified', 'invalid initialization metadata');
  }

  if (
    config.version !== CONFIG_VERSION ||
    typeof config.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(config.createdAt)) ||
    typeof config.anchor !== 'string' ||
    pathKey(config.anchor) !== pathKey(root) ||
    config.anchorKind !== initialization.evidence ||
    typeof config.trailId !== 'string' ||
    config.trailId.length === 0
  ) {
    return refusal('config-modified', 'automatic config no longer matches its defaults');
  }

  if (!isObject(config.settings)) {
    return refusal('config-modified', 'settings are missing');
  }
  const settings = config.settings;
  if (
    !hasOnlyKeys(
      settings,
      new Set(['git', 'captureAiOutput', 'captureCode', 'captureToolCalls', 'redact']),
    ) ||
    typeof settings.git !== 'boolean' ||
    settings.captureAiOutput !== true ||
    settings.captureCode !== true ||
    settings.captureToolCalls !== true ||
    !isObject(settings.redact) ||
    !hasOnlyKeys(settings.redact, new Set(['enabled', 'secrets', 'pii'])) ||
    settings.redact.enabled !== true ||
    settings.redact.secrets !== true ||
    settings.redact.pii !== true
  ) {
    return refusal('config-modified', 'settings no longer match automatic defaults');
  }

  return { trailId: config.trailId };
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function hasGitMarker(start: string): boolean {
  let cursor = resolve(start);
  while (true) {
    if (existsSync(join(cursor, '.git'))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

async function checkGit(root: string, base: string): Promise<Refusal | null> {
  const top = await runGit(['rev-parse', '--show-toplevel'], root);
  if (!top.ok) {
    return hasGitMarker(root)
      ? refusal('git-state-unknown', 'git metadata exists but could not be read')
      : null;
  }

  // Git interprets pathspecs relative to `root`, including when `root` is nested
  // below the repository top level. Keeping this local also avoids comparing
  // Git's long path spelling with a possible Windows 8.3 cwd.
  const pathspec = basename(base);
  const tracked = await runGit(['ls-files', '-z', '--', pathspec], root);
  if (!tracked.ok) return refusal('git-state-unknown', 'git index could not be read');
  if (tracked.stdout.length > 0) return refusal('git-tracked');

  const history = await runGit(
    ['log', '--all', '--format=%H', '-n', '1', '--', pathspec],
    root,
  );
  if (history.ok) {
    if (history.stdout.trim().length > 0) return refusal('git-tracked');
    return null;
  }
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], root);
  return head.ok ? refusal('git-state-unknown', 'git history could not be read') : null; // An unborn repository has no history to contain this trail.
}

/** Wait for Git index writers that started before the trail was quarantined. */
async function waitForGitIndexQuiescence(
  root: string,
  onLockObserved?: () => void | Promise<void>,
): Promise<Refusal | null> {
  const result = await runGit(['rev-parse', '--git-path', 'index.lock'], root);
  if (!result.ok) {
    return hasGitMarker(root)
      ? refusal('git-state-unknown', 'git index lock path could not be read')
      : null;
  }
  const rawPath = result.stdout.trim();
  if (!rawPath) return refusal('git-state-unknown', 'git index lock path is empty');
  const lockPath = resolve(root, rawPath);
  const deadline = Date.now() + GIT_LOCK_WAIT_MS;
  let quietSince: number | undefined;
  let notified = false;

  while (Date.now() <= deadline) {
    const now = Date.now();
    if (existsSync(lockPath)) {
      quietSince = undefined;
      if (!notified) {
        notified = true;
        await onLockObserved?.();
      }
    } else {
      quietSince ??= now;
      if (now - quietSince >= GIT_LOCK_QUIET_MS) return null;
    }
    await delay(GIT_LOCK_POLL_MS);
  }
  return refusal('git-state-unknown', 'git index remained busy during the prune claim');
}

function targetMatchesRoot(
  target: LedgerTargetShape,
  trailId: string,
  root: string,
): boolean {
  if (target.trailId === trailId) return true;
  return typeof target.path === 'string' && pathKey(target.path) === pathKey(root);
}

function checkLedger(
  root: string,
  trailId: string,
  ledgerSessionId: string,
): LedgerCheck | Refusal {
  const base = ledgerDir();
  const indexFile = join(base, 'index.json');
  const sessionsDir = join(base, 'sessions');
  if (!existsSync(indexFile) || !existsSync(sessionsDir)) {
    return refusal(
      'ledger-state-unknown',
      'ledger index or sessions directory is missing',
    );
  }

  let index: unknown;
  try {
    index = strictJson(indexFile);
  } catch {
    return refusal('ledger-state-unknown', 'ledger index is unreadable');
  }
  if (!isObject(index) || !isObject(index.sessions) || !isObject(index.trails)) {
    return refusal('ledger-state-unknown', 'ledger index has an unknown shape');
  }

  let creator: LedgerSessionShape | undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return refusal('ledger-state-unknown', 'ledger sessions could not be listed');
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return refusal('ledger-state-unknown', 'ledger contains an unknown session entry');
    }
    let raw: unknown;
    try {
      raw = strictJson(join(sessionsDir, entry.name, 'session.json'));
    } catch {
      return refusal('ledger-state-unknown', 'a ledger session is unreadable');
    }
    if (!isObject(raw) || raw.id !== entry.name) {
      return refusal('ledger-state-unknown', 'a ledger session has an unknown shape');
    }
    const session = raw as LedgerSessionShape;
    const targets = session.targets === undefined ? [] : session.targets;
    if (!Array.isArray(targets) || targets.some((target) => !isObject(target))) {
      return refusal('ledger-state-unknown', 'a ledger target has an unknown shape');
    }
    if (
      entry.name !== ledgerSessionId &&
      targets.some((target) =>
        targetMatchesRoot(target as LedgerTargetShape, trailId, root),
      )
    ) {
      return refusal('other-ledger-placement', entry.name);
    }
    if (entry.name === ledgerSessionId) creator = session;
  }

  if (
    !creator ||
    typeof creator.nativeSessionId !== 'string' ||
    creator.nativeSessionId.length === 0
  ) {
    return refusal('ledger-state-unknown', 'originating ledger session is missing');
  }

  for (const [sessionId, rawTargets] of Object.entries(index.sessions)) {
    if (!Array.isArray(rawTargets) || rawTargets.some((id) => typeof id !== 'string')) {
      return refusal(
        'ledger-state-unknown',
        'ledger placement index has an unknown shape',
      );
    }
    if (sessionId !== ledgerSessionId && rawTargets.includes(trailId)) {
      return refusal('other-ledger-placement', sessionId);
    }
  }
  for (const [indexedTrailId, rawLocation] of Object.entries(index.trails)) {
    if (!isObject(rawLocation) || typeof rawLocation.path !== 'string') {
      return refusal('ledger-state-unknown', 'ledger trail index has an unknown shape');
    }
    if (indexedTrailId !== trailId && pathKey(rawLocation.path) === pathKey(root)) {
      return refusal('other-ledger-placement', indexedTrailId);
    }
    if (indexedTrailId === trailId && pathKey(rawLocation.path) !== pathKey(root)) {
      return refusal('ledger-state-unknown', 'trail id is indexed at a different path');
    }
  }

  return {
    creator: {
      nativeSessionId: creator.nativeSessionId,
      ...(typeof creator.tool === 'string' ? { tool: creator.tool } : {}),
    },
  };
}

function directoryEntries(dir: string): Dirent[] | Refusal {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return refusal('unknown-file', `cannot list ${basename(dir)}`);
  }
}

function regularFile(file: string): boolean {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateAuthor(
  authorsDir: string,
  authorEntry: Dirent,
  ledgerSessionId: string,
  creator: LedgerCheck['creator'],
): (TrailScan & { refs: Set<string>; plans: Set<string> }) | Refusal {
  const authorDir = join(authorsDir, authorEntry.name);
  const entries = directoryEntries(authorDir);
  if (!Array.isArray(entries)) return entries;
  const allowed = new Set(['author.json', 'sessions.json', 'sessions', 'journal']);
  if (entries.some((entry) => !allowed.has(entry.name) || entry.isSymbolicLink())) {
    return refusal('unknown-file', `authors/${authorEntry.name}`);
  }

  const authorFile = join(authorDir, 'author.json');
  if (!regularFile(authorFile))
    return refusal('unrelated-trail-data', 'author is missing');
  try {
    const author = strictJson(authorFile);
    if (
      !isObject(author) ||
      author.slug !== authorEntry.name ||
      !hasOnlyKeys(
        author,
        new Set(['slug', 'email', 'name', 'githubLogin', 'createdAt', 'provisional']),
      )
    ) {
      return refusal('unrelated-trail-data', 'author metadata was modified');
    }
  } catch {
    return refusal('unrelated-trail-data', 'author metadata is unreadable');
  }

  const sessionRows = new Map<string, Record<string, unknown>>();
  const sessionFiles: string[] = [];
  const legacySessions = join(authorDir, 'sessions.json');
  if (existsSync(legacySessions)) sessionFiles.push(legacySessions);
  const sessionsDir = join(authorDir, 'sessions');
  if (existsSync(sessionsDir)) {
    const shards = directoryEntries(sessionsDir);
    if (!Array.isArray(shards)) return shards;
    for (const shard of shards) {
      if (!shard.isFile() || shard.isSymbolicLink() || !shard.name.endsWith('.json')) {
        return refusal('unknown-file', `authors/${authorEntry.name}/sessions`);
      }
      sessionFiles.push(join(sessionsDir, shard.name));
    }
  }
  for (const file of sessionFiles) {
    let raw: unknown;
    try {
      raw = strictJson(file);
    } catch {
      return refusal('unrelated-trail-data', 'session metadata is unreadable');
    }
    if (!Array.isArray(raw) || raw.some((row) => !isObject(row))) {
      return refusal('unrelated-trail-data', 'session metadata has an unknown shape');
    }
    for (const row of raw as Record<string, unknown>[]) {
      if (
        typeof row.id !== 'string' ||
        typeof row.nativeSessionId !== 'string' ||
        row.nativeSessionId !== creator.nativeSessionId ||
        (creator.tool !== undefined &&
          row.tool !== undefined &&
          row.tool !== creator.tool)
      ) {
        return refusal('unrelated-trail-data', 'session belongs to other work');
      }
      const existing = sessionRows.get(row.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
        return refusal('unrelated-trail-data', 'session shards disagree');
      }
      sessionRows.set(row.id, row);
    }
  }

  const refs = new Set<string>();
  const plans = new Set<string>();
  const repoSessionIds = new Set<string>();
  const eventIds = new Set<string>();
  const journalDir = join(authorDir, 'journal');
  if (existsSync(journalDir)) {
    const shards = directoryEntries(journalDir);
    if (!Array.isArray(shards)) return shards;
    for (const shard of shards) {
      if (!shard.isDirectory() || shard.isSymbolicLink()) {
        return refusal('unknown-file', `authors/${authorEntry.name}/journal`);
      }
      const segments = directoryEntries(join(journalDir, shard.name));
      if (!Array.isArray(segments)) return segments;
      for (const segment of segments) {
        if (
          !segment.isFile() ||
          segment.isSymbolicLink() ||
          !/^\d+\.log$/.test(segment.name)
        ) {
          return refusal(
            'unknown-file',
            `authors/${authorEntry.name}/journal/${shard.name}`,
          );
        }
        let lines: string[];
        try {
          lines = readFileSync(join(journalDir, shard.name, segment.name), 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        } catch {
          return refusal('unrelated-trail-data', 'journal is unreadable');
        }
        for (const line of lines) {
          let entry: unknown;
          try {
            entry = JSON.parse(line) as unknown;
          } catch {
            return refusal('unrelated-trail-data', 'journal contains invalid JSON');
          }
          if (
            !isObject(entry) ||
            (entry.batch !== `ledger:${ledgerSessionId}` &&
              !(
                typeof entry.batch === 'string' &&
                entry.batch.startsWith(`ledger:${ledgerSessionId}:seg_`)
              )) ||
            typeof entry.id !== 'string' ||
            typeof entry.conv !== 'string' ||
            entry.conv.length === 0 ||
            (entry.actorSlug !== undefined && entry.actorSlug !== authorEntry.name)
          ) {
            return refusal('unrelated-trail-data', 'journal contains other work');
          }
          eventIds.add(entry.id);
          repoSessionIds.add(entry.conv);
          const entryRefs = entry.refs === undefined ? [] : entry.refs;
          if (
            !Array.isArray(entryRefs) ||
            entryRefs.some((ref) => typeof ref !== 'string')
          ) {
            return refusal(
              'unrelated-trail-data',
              'journal contains invalid object refs',
            );
          }
          for (const ref of entryRefs as string[]) refs.add(ref);
          if (entry.diffHash !== undefined) {
            if (typeof entry.diffHash !== 'string') {
              return refusal(
                'unrelated-trail-data',
                'journal contains an invalid diff ref',
              );
            }
            refs.add(entry.diffHash);
          }
          if (entry.planPath !== undefined) {
            if (
              typeof entry.planPath !== 'string' ||
              !/^plans\/[A-Za-z0-9_.-]+\.md$/.test(entry.planPath)
            ) {
              return refusal(
                'unrelated-trail-data',
                'journal contains an invalid plan path',
              );
            }
            plans.add(entry.planPath.slice('plans/'.length));
          }
        }
      }
    }
  }

  for (const sessionId of sessionRows.keys()) {
    if (repoSessionIds.size > 0 && !repoSessionIds.has(sessionId)) {
      return refusal('unrelated-trail-data', 'unreferenced repo session');
    }
  }
  for (const sessionId of repoSessionIds) {
    if (!sessionRows.has(sessionId)) {
      return refusal('unrelated-trail-data', 'journal session metadata is missing');
    }
  }
  if (repoSessionIds.size === 0 && sessionRows.size > 1) {
    return refusal('unrelated-trail-data', 'multiple empty repo sessions');
  }

  return { repoSessionIds, eventIds, authorSlug: authorEntry.name, refs, plans };
}

function validateObjectStore(
  objectsDir: string,
  expectedRefs: Set<string>,
): Refusal | null {
  const expected = new Set<string>();
  for (const ref of expectedRefs) {
    const match = /^sha256:([0-9a-f]{64})$/.exec(ref);
    if (!match) return refusal('unrelated-trail-data', 'unknown object reference');
    expected.add(`${match[1]!.slice(0, 2)}/${match[1]!.slice(2)}`);
  }

  const actual = new Set<string>();
  const shards = directoryEntries(objectsDir);
  if (!Array.isArray(shards)) return shards;
  for (const shard of shards) {
    if (
      !shard.isDirectory() ||
      shard.isSymbolicLink() ||
      !/^[0-9a-f]{2}$/.test(shard.name)
    ) {
      return refusal('unknown-file', 'objects');
    }
    const objects = directoryEntries(join(objectsDir, shard.name));
    if (!Array.isArray(objects)) return objects;
    for (const object of objects) {
      if (
        !object.isFile() ||
        object.isSymbolicLink() ||
        !/^[0-9a-f]{62}$/.test(object.name)
      ) {
        return refusal('unknown-file', `objects/${shard.name}`);
      }
      const key = `${shard.name}/${object.name}`;
      let content: Buffer;
      try {
        content = readFileSync(join(objectsDir, shard.name, object.name));
      } catch {
        return refusal('unrelated-trail-data', 'object is unreadable');
      }
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== shard.name + object.name) {
        return refusal('unrelated-trail-data', 'object content was modified');
      }
      actual.add(key);
    }
  }
  if (
    actual.size !== expected.size ||
    [...actual].some((object) => !expected.has(object))
  ) {
    return refusal('unrelated-trail-data', 'object store is not owned by this session');
  }
  return null;
}

function validatePlans(plansDir: string, expected: Set<string>): Refusal | null {
  if (!existsSync(plansDir)) {
    return expected.size === 0
      ? null
      : refusal('unrelated-trail-data', 'referenced plan is missing');
  }
  const entries = directoryEntries(plansDir);
  if (!Array.isArray(entries)) return entries;
  const actual = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) {
      return refusal('unknown-file', 'plans');
    }
    actual.add(entry.name);
  }
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) {
    return refusal('unrelated-trail-data', 'plans are not owned by this session');
  }
  return null;
}

function validateState(
  file: string,
  scan: TrailScan,
  nativeSessionId: string,
): Refusal | null {
  let raw: unknown;
  try {
    raw = strictJson(file);
  } catch {
    return refusal('unrelated-trail-data', 'state is unreadable');
  }
  if (
    !isObject(raw) ||
    !hasOnlyKeys(
      raw,
      new Set([
        'currentSessionId',
        'currentAuthorSlug',
        'currentPromptId',
        'turnByNativeSession',
      ]),
    ) ||
    (raw.currentSessionId !== null &&
      (typeof raw.currentSessionId !== 'string' ||
        !scan.repoSessionIds.has(raw.currentSessionId))) ||
    (raw.currentAuthorSlug !== undefined && raw.currentAuthorSlug !== scan.authorSlug) ||
    (raw.currentPromptId !== undefined &&
      raw.currentPromptId !== null &&
      (typeof raw.currentPromptId !== 'string' ||
        !scan.eventIds.has(raw.currentPromptId)))
  ) {
    return refusal('unrelated-trail-data', 'state points at other work');
  }
  if (raw.turnByNativeSession !== undefined) {
    if (!isObject(raw.turnByNativeSession)) {
      return refusal('unrelated-trail-data', 'turn state has an unknown shape');
    }
    for (const [nativeId, eventId] of Object.entries(raw.turnByNativeSession)) {
      if (
        nativeId !== nativeSessionId ||
        typeof eventId !== 'string' ||
        !scan.eventIds.has(eventId)
      ) {
        return refusal('unrelated-trail-data', 'turn state points at other work');
      }
    }
  }
  return null;
}

function validateDiag(
  diagDir: string,
  scan: TrailScan,
  nativeSessionId: string,
): Refusal | null {
  if (!existsSync(diagDir)) return null;
  const entries = directoryEntries(diagDir);
  if (!Array.isArray(entries)) return entries;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== 'hooks.jsonl') {
      return refusal('unknown-file', 'diag');
    }
    let lines: string[];
    try {
      lines = readFileSync(join(diagDir, entry.name), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
    } catch {
      return refusal('unrelated-trail-data', 'hook diagnostics are unreadable');
    }
    for (const line of lines) {
      let trace: unknown;
      try {
        trace = JSON.parse(line) as unknown;
      } catch {
        return refusal('unrelated-trail-data', 'hook diagnostics contain invalid JSON');
      }
      if (
        !isObject(trace) ||
        (trace.nativeSessionId !== undefined &&
          trace.nativeSessionId !== nativeSessionId) ||
        (trace.sessionId !== undefined &&
          (typeof trace.sessionId !== 'string' ||
            !scan.repoSessionIds.has(trace.sessionId))) ||
        (Array.isArray(trace.closedSessions) &&
          trace.closedSessions.some(
            (id) => typeof id !== 'string' || !scan.repoSessionIds.has(id),
          ))
      ) {
        return refusal('unrelated-trail-data', 'hook diagnostics mention other work');
      }
    }
  }
  return null;
}

function checkTrailContents(
  base: string,
  ledgerSessionId: string,
  creator: LedgerCheck['creator'],
): Refusal | null {
  const top = directoryEntries(base);
  if (!Array.isArray(top)) return top;
  const allowedTop = new Set([
    'config.json',
    'state.json',
    '.gitattributes',
    '.gitignore',
    'authors',
    'objects',
    'plans',
    'reports',
    'diag',
  ]);
  if (top.some((entry) => !allowedTop.has(entry.name) || entry.isSymbolicLink())) {
    return refusal('unknown-file', 'trail root');
  }

  for (const file of ['config.json', 'state.json', '.gitattributes', '.gitignore']) {
    if (!regularFile(join(base, file))) return refusal('unknown-file', file);
  }
  for (const dir of ['authors', 'objects', 'reports']) {
    try {
      const stat = lstatSync(join(base, dir));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return refusal('unknown-file', dir);
    } catch {
      return refusal('unknown-file', dir);
    }
  }
  try {
    if (readFileSync(join(base, '.gitattributes'), 'utf8') !== GITATTRIBUTES) {
      return refusal('config-modified', '.gitattributes was modified');
    }
    if (readFileSync(join(base, '.gitignore'), 'utf8') !== GITIGNORE) {
      return refusal('config-modified', '.gitignore was modified');
    }
  } catch {
    return refusal('unknown-file', 'generated metadata is unreadable');
  }

  const reports = directoryEntries(join(base, 'reports'));
  if (!Array.isArray(reports)) return reports;
  if (reports.length > 0) return refusal('report-present');

  const authors = directoryEntries(join(base, 'authors'));
  if (!Array.isArray(authors)) return authors;
  if (
    authors.length > 1 ||
    authors.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    return refusal('unrelated-trail-data', 'trail contains multiple or invalid authors');
  }

  let scan: TrailScan & { refs: Set<string>; plans: Set<string> } = {
    repoSessionIds: new Set(),
    eventIds: new Set(),
    refs: new Set(),
    plans: new Set(),
  };
  if (authors[0]) {
    const checked = validateAuthor(
      join(base, 'authors'),
      authors[0],
      ledgerSessionId,
      creator,
    );
    if ('reason' in checked) return checked;
    scan = checked;
  }

  const objects = validateObjectStore(join(base, 'objects'), scan.refs);
  if (objects) return objects;
  const plans = validatePlans(join(base, 'plans'), scan.plans);
  if (plans) return plans;
  const state = validateState(join(base, 'state.json'), scan, creator.nativeSessionId);
  if (state) return state;
  return validateDiag(join(base, 'diag'), scan, creator.nativeSessionId);
}

function treeFingerprint(base: string): string | null {
  const rows: string[] = [];
  const visit = (path: string): boolean => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return false;
    }
    const rel = relative(base, path).split(sep).join('/');
    if (stat.isSymbolicLink()) {
      rows.push(`${rel}\0link`);
      return true;
    }
    if (stat.isFile()) {
      try {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        rows.push(`${rel}\0file\0${stat.size}\0${digest}`);
        return true;
      } catch {
        return false;
      }
    }
    if (!stat.isDirectory()) return false;
    rows.push(`${rel}\0dir`);
    let entries: string[];
    try {
      entries = readdirSync(path).sort();
    } catch {
      return false;
    }
    return entries.every((entry) => visit(join(path, entry)));
  };
  return visit(base) ? createHash('sha256').update(rows.join('\n')).digest('hex') : null;
}

function quarantinePath(root: string): string {
  return join(
    root,
    `${SHOWTAIL_DIR}.prune-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
}

/**
 * Put a claimed quarantine back when pruning is refused. If another writer
 * recreated the original path, keep both trees rather than overwriting either.
 */
function preserveQuarantine(
  base: string,
  quarantine: string,
  result: Refusal,
  detail: string,
): Refusal {
  const recoveryDetail =
    result.detail === undefined || result.detail === detail
      ? detail
      : `${result.detail}; ${detail}`;
  if (!existsSync(quarantine)) {
    return refusal('delete-failed', `${recoveryDetail}; quarantine disappeared`);
  }
  if (!existsSync(base)) {
    try {
      renameSync(quarantine, base);
      return result;
    } catch {
      // The private path remains the recovery copy if the atomic restore loses a race.
    }
  }
  return {
    ...result,
    detail: `${recoveryDetail}; original trail preserved at ${quarantine}`,
  };
}

/** Restore a claimed trail before propagating an automatic-capture interruption. */
function requireClaimContinuation(
  continueCapture: (() => boolean) | undefined,
  base: string,
  quarantine: string,
): void {
  try {
    requireCaptureContinuation(continueCapture);
  } catch (error) {
    if (error instanceof CaptureInterruptedError) {
      preserveQuarantine(
        base,
        quarantine,
        refusal('trail-changed-during-check', 'capture consent changed during pruning'),
        'capture consent changed during pruning',
      );
    }
    throw error;
  }
}

/**
 * A renamed trail is no longer reachable by ordinary Showtail writers. Give an
 * already-started synchronous write a brief chance to finish, then require the
 * private tree to remain byte-for-byte stable before deleting it.
 */
async function quarantineStayedPristine(
  base: string,
  quarantine: string,
  expectedFingerprint: string,
): Promise<boolean> {
  const first = treeFingerprint(quarantine);
  if (existsSync(base) || first !== expectedFingerprint) return false;
  await delay(QUARANTINE_SETTLE_MS);
  const second = treeFingerprint(quarantine);
  return !existsSync(base) && second === first && second === expectedFingerprint;
}

/**
 * Delete one provisional trail only when its config, ledger ownership, git
 * status, and complete file tree prove it contains no durable or unrelated work.
 */
export async function pruneProvisionalTrail(
  options: ProvisionalTrailPruneOptions,
): Promise<ProvisionalTrailPruneResult> {
  requireCaptureContinuation(options.continueCapture);
  const root = resolve(options.root);
  const base = join(root, SHOWTAIL_DIR);
  if (
    basename(base) !== SHOWTAIL_DIR ||
    pathKey(dirname(base)) !== pathKey(root) ||
    options.ledgerSessionId.length === 0
  ) {
    return { pruned: false, reason: 'unsafe-root' };
  }
  if (!existsSync(base)) return { pruned: false, reason: 'trail-not-found' };
  try {
    const stat = lstatSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { pruned: false, reason: 'unsafe-root' };
    }
  } catch {
    return { pruned: false, reason: 'trail-not-found' };
  }

  const initialFingerprint = treeFingerprint(base);
  if (!initialFingerprint) {
    return { pruned: false, reason: 'unknown-file', detail: 'trail is unreadable' };
  }

  let configRaw: unknown;
  try {
    configRaw = strictJson(join(base, 'config.json'));
  } catch {
    return { pruned: false, reason: 'config-unreadable' };
  }
  const config = validateConfig(configRaw, root, options.ledgerSessionId);
  if ('reason' in config) return { pruned: false, ...config };
  const withTrail = (result: Refusal): ProvisionalTrailPruneResult => ({
    pruned: false,
    trailId: config.trailId,
    ...result,
  });

  const git = await checkGit(root, base);
  requireCaptureContinuation(options.continueCapture);
  if (git) return withTrail(git);
  const ledger = checkLedger(root, config.trailId, options.ledgerSessionId);
  if ('reason' in ledger) return withTrail(ledger);
  const contents = checkTrailContents(base, options.ledgerSessionId, ledger.creator);
  if (contents) return withTrail(contents);

  const finalFingerprint = treeFingerprint(base);
  if (!finalFingerprint || finalFingerprint !== initialFingerprint) {
    return withTrail(refusal('trail-changed-during-check'));
  }

  await options.testHooks?.beforeClaim?.();
  requireCaptureContinuation(options.continueCapture);

  // Atomically move the validated tree to an unpredictable private name before
  // deleting it. New writers continue to target `.showtail/` and therefore can
  // no longer enter the tree being removed. A writer already in flight follows
  // the renamed tree; the stable post-claim fingerprint below catches it and
  // restores/preserves the quarantine instead of deleting its data.
  const quarantine = quarantinePath(root);
  try {
    requireCaptureContinuation(options.continueCapture);
    renameSync(base, quarantine);
  } catch (error) {
    if (error instanceof CaptureInterruptedError) throw error;
    return withTrail(
      refusal(
        existsSync(base) ? 'delete-failed' : 'trail-changed-during-check',
        'could not claim the trail for pruning',
      ),
    );
  }
  requireClaimContinuation(options.continueCapture, base, quarantine);

  const quarantinePristine = await quarantineStayedPristine(
    base,
    quarantine,
    finalFingerprint,
  );
  requireClaimContinuation(options.continueCapture, base, quarantine);
  if (!quarantinePristine) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        refusal('trail-changed-during-check', 'trail changed after the prune claim'),
        'trail changed after the prune claim',
      ),
    );
  }

  let gitLockNotified = false;
  const notifyGitLock = async (): Promise<void> => {
    if (gitLockNotified) return;
    gitLockNotified = true;
    await options.testHooks?.onGitIndexLock?.();
  };
  const gitBeforeCheck = await waitForGitIndexQuiescence(root, notifyGitLock);
  requireClaimContinuation(options.continueCapture, base, quarantine);
  if (gitBeforeCheck) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        gitBeforeCheck,
        'git was busy after the prune claim',
      ),
    );
  }

  // Git can change after the initial validation without changing any trail
  // bytes. Recheck after claiming the tree so a concurrent add or commit keeps
  // the exact data Git now references.
  const claimedGit = await checkGit(root, base);
  requireClaimContinuation(options.continueCapture, base, quarantine);
  if (claimedGit) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        claimedGit,
        'git state changed after the prune claim',
      ),
    );
  }

  // A Git writer may have started while the first recheck was reading the old
  // index. Once the original path is quarantined no new add can discover it, so
  // draining that writer and checking once more closes the publication window.
  const gitAfterCheck = await waitForGitIndexQuiescence(root, notifyGitLock);
  requireClaimContinuation(options.continueCapture, base, quarantine);
  if (gitAfterCheck) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        gitAfterCheck,
        'git was busy during the post-claim recheck',
      ),
    );
  }
  const settledGit = await checkGit(root, base);
  requireClaimContinuation(options.continueCapture, base, quarantine);
  if (settledGit) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        settledGit,
        'git state changed during the post-claim recheck',
      ),
    );
  }

  if (existsSync(base) || treeFingerprint(quarantine) !== finalFingerprint) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        refusal('trail-changed-during-check', 'trail changed during the git recheck'),
        'trail changed during the git recheck',
      ),
    );
  }

  requireClaimContinuation(options.continueCapture, base, quarantine);
  try {
    rmSync(quarantine, { recursive: true, force: false });
  } catch {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        refusal('trail-changed-during-check', 'could not remove the claimed trail'),
        'could not remove the claimed trail',
      ),
    );
  }
  if (existsSync(quarantine)) {
    return withTrail(
      preserveQuarantine(
        base,
        quarantine,
        refusal('trail-changed-during-check', 'claimed trail still exists after removal'),
        'claimed trail still exists after removal',
      ),
    );
  }
  return { pruned: true, reason: 'pruned', trailId: config.trailId };
}
