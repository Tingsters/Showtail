/**
 * Turn a report's data into something that is safe to leave the machine.
 *
 * `buildReportData` reads the private working trail, which holds the student's raw
 * prompts, the AI's replies and code diffs. Here every text field is run through
 * the sharing-time sanitiser (known values, pattern rules, default-deny opaque
 * tokens), machine paths are replaced, and then an independent scanner looks over
 * the result. Anything the scanner still finds blocks the share: the caller gets
 * the findings (labels and counts, never values) and no data.
 *
 * Fields are handled by what they are, not by guessing: timestamps and enums pass
 * through, ids/hashes/paths get the precise rules but not the opaque-token filter
 * (a 64-character hash there is expected), and everything else is free text.
 */
import { homedir } from 'node:os';
import type { ReportData } from '../types.ts';
import { redactDetailed } from './redact.ts';
import { type Finding, sanitizeForShare, scanResidual } from './sanitize.ts';

/** Fields whose values are not secrets and are shown as-is (dates, enums, names). */
const PASS = new Set([
  'email',
  'githubLogin',
  'ts',
  'timestamp',
  'generatedAt',
  'from',
  'to',
  'type',
  'tool',
  'model',
  'status',
  'toolName',
  'slug',
  'actorSlug',
]);

/** Ids, hashes and paths: precise rules apply, the opaque-token filter does not. */
const STRUCTURAL = new Set([
  'id',
  'turnId',
  'sessionId',
  'batchId',
  'sha256',
  'diffHash',
  'gitCommit',
  'planPath',
  'path',
  'linkPath',
  'file',
  'files',
]);

export interface ShareResult {
  /** The sanitised copy of the report data. Absent when the scan blocked it. */
  data: ReportData;
  /** How many values were withheld or redacted across the whole report. */
  withheld: number;
  /** Counts by layer or rule label (never values). */
  byLabel: Record<string, number>;
  /** What the independent scanner still found. Non-empty means: do not share. */
  findings: Finding[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A case-insensitive pattern matching `p` with either slash style. */
function pathPattern(p: string): RegExp | undefined {
  const clean = p.replace(/[\\/]+$/, '');
  if (clean.length < 4) return undefined; // "/" or "C:" would match far too much
  const body = escapeRegex(clean).replace(/\\\\|\//g, '[\\\\/]');
  return new RegExp(body, 'gi');
}

/** Replace the project root and the home directory so no machine path is shared. */
export function localizePaths(text: string, root?: string): string {
  let out = text;
  for (const [dir, replacement] of [
    [root, '<project>'],
    [homedir(), '~'],
  ] as const) {
    const re = dir ? pathPattern(dir) : undefined;
    if (re) out = out.replace(re, replacement);
  }
  return out;
}

interface Tally {
  withheld: number;
  byLabel: Record<string, number>;
  scan: Map<string, number>;
}

function add(tally: Tally, label: string, n: number): void {
  if (n > 0) tally.byLabel[label] = (tally.byLabel[label] ?? 0) + n;
}

function cleanString(
  value: string,
  key: string,
  root: string | undefined,
  t: Tally,
): string {
  if (PASS.has(key)) {
    // Shown as-is, but still scanned: an imported trail controls these values.
    for (const f of scanResidual(value, { structural: true })) {
      t.scan.set(f.kind, (t.scan.get(f.kind) ?? 0) + f.count);
    }
    return value;
  }
  const structural = STRUCTURAL.has(key);
  const localized = localizePaths(value, root);
  let text: string;
  if (structural) {
    // Forced on: a committed config must not be able to switch sharing-time rules off.
    const r = redactDetailed(localized, { enabled: true, secrets: true, pii: true });
    text = r.text;
    t.withheld += r.hits;
    for (const [label, n] of Object.entries(r.byLabel)) add(t, label, n);
  } else {
    const r = sanitizeForShare(localized);
    text = r.text;
    t.withheld += r.hits;
    for (const [label, n] of Object.entries(r.byLabel)) add(t, label, n);
  }
  for (const f of scanResidual(text, { structural })) {
    t.scan.set(f.kind, (t.scan.get(f.kind) ?? 0) + f.count);
  }
  return text;
}

function walk(value: unknown, key: string, root: string | undefined, t: Tally): unknown {
  if (typeof value === 'string') return cleanString(value, key, root, t);
  if (Array.isArray(value)) return value.map((v) => walk(v, key, root, t));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, k, root, t);
    }
    return out;
  }
  return value;
}

/** Sanitise a whole report and scan it. `root` is the project root, to localise paths. */
export function sanitizeReportData(data: ReportData, root?: string): ShareResult {
  const tally: Tally = { withheld: 0, byLabel: {}, scan: new Map() };
  const clean = walk(data, '', root, tally) as ReportData;
  clean.redactionCount = (data.redactionCount ?? 0) + tally.withheld;
  return {
    data: clean,
    withheld: tally.withheld,
    byLabel: tally.byLabel,
    findings: [...tally.scan].map(([kind, count]) => ({ kind, count })),
  };
}
