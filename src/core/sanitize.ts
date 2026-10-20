/**
 * The sharing-time sanitiser: what stands between the working trail and anything
 * that leaves the machine (`showtail submit`, a PR comment).
 *
 * Three layers, each independent of the others' ability to recognise a secret:
 *
 *  1. **Known values** (`knownSecrets.ts`): the student's real keys, in any format
 *     and any encoding. Does not care what a key looks like.
 *  2. **Pattern rules** (`redact.ts`): provider formats and `NAME=value` context.
 *     Catches secrets that are *not* on this machine (a key the AI invented, one
 *     pasted from elsewhere) when they have a recognisable shape or label.
 *  3. **Default-deny opaque tokens** (here): any long token that is not recognisably
 *     ordinary (a word, an identifier, a path, a hash, a version, a UUID, a date)
 *     is withheld. Secrets are, by nature, long random strings, so this holds for
 *     formats nobody has seen yet. It over-redacts on purpose: a withheld token is
 *     cosmetic, a leaked key is not.
 *
 * Everything fails closed: if a layer throws, the text is withheld entirely.
 */
import type { RedactConfig } from '../types.ts';
import { getKnownSecretMatcher } from './knownSecrets.ts';
import { redactDetailed } from './redact.ts';

export const WITHHELD = '‹withheld›';

/** Shannon entropy in bits per character. */
export function shannon(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Tunables, named so they can be calibrated against the corpus tests. */
export const OPAQUE = {
  /** Runs shorter than this are never withheld by this layer. */
  minLength: 20,
  /** Letters/separators only (identifiers, paths, prose): needs to be this random. */
  lettersOnlyEntropy: 4.35,
  /** Anything containing a digit: lower bar, because digits are the giveaway. */
  withDigitsEntropy: 3.1,
};

/** A run of characters that could be part of one opaque token. */
const RUN = /[A-Za-z0-9+/=_.~%-]{20,}/g;

const ALLOW: RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{40}$/i, // a git commit id
  /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/, // a version
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/, // an ISO timestamp
  /^[\d.:/-]+$/, // numbers, dates, IPs, ratios
  // A session/file id: words, then a UUID (`rollout-2026-…-<uuid>`, `session_<uuid>`).
  /^[A-Za-z][A-Za-z0-9_-]*[_-][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.\w+)?$/i,
  // Showtail's own ids: `ses_mvh3onq6_0d4f98`, `evt_lqz3k8_a1b2`.
  /^(?:ses|evt|art|led|trl|bat|turn|plan|pln)_[a-z0-9]{4,12}_[a-z0-9]{3,10}$/,
];

function trimEdges(s: string): string {
  return s.replace(/^[.\-_=/+%~]+|[.\-_=/+%~]+$/g, '');
}

/**
 * Whether one run of token characters looks like a generated secret rather than
 * ordinary text. `before` is the text just ahead of the run (used to recognise a
 * `sha256:` prefix, which marks a file hash rather than a key).
 */
export function isOpaqueRun(run: string, before = ''): boolean {
  const r = trimEdges(run);
  if (r.length < OPAQUE.minLength) return false;
  if (ALLOW.some((re) => re.test(r))) return false;
  if (/^[0-9a-f]{64}$/i.test(r) && /sha(?:256)?:?$/i.test(before)) return false;

  const hasDigit = /\d/.test(r);
  const entropy = shannon(r);
  if (!hasDigit) {
    // Letters only. With separators (`.` `/` `_` `-`) it is an identifier, a path or
    // a phrase made of words (`process.env.SHOWTAIL_HOME`), never a secret we can
    // tell apart from one. Without separators it must look random to be withheld.
    if (/[._/-]/.test(r)) return false;
    return /[a-z]/.test(r) && /[A-Z]/.test(r) && entropy >= OPAQUE.lettersOnlyEntropy;
  }
  // Hex strings are opaque however regular they look.
  if (/^[0-9a-fA-F]+$/.test(r)) return true;
  // With digits it must also contain a *piece* that is itself random-looking: words
  // glued to a number (`darwin-arm64`, `claude-haiku-4-5`) have none; a key does.
  return entropy >= OPAQUE.withDigitsEntropy && hasRandomPiece(r);
}

/**
 * A piece (split on `. / _ -`) that mixes letters and digits and is long enough
 * that the mix is not an accident (`arm64`, `v2`, `utf8` are too short to count).
 */
function hasRandomPiece(run: string): boolean {
  return run
    .split(/[._-]+/)
    .some((p) => p.length >= 6 && /\d/.test(p) && /[A-Za-z]/.test(p));
}

/** Withhold every opaque token in `text`; returns the text and how many were withheld. */
export function withholdOpaqueTokens(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(RUN, (run, offset: number) => {
    if (!isOpaqueRun(run, text.slice(Math.max(0, offset - 8), offset))) return run;
    hits += 1;
    return WITHHELD;
  });
  return { text: out, hits };
}

export interface SanitizeResult {
  text: string;
  /** How many values were removed across all layers. */
  hits: number;
  /** Per-layer / per-rule counts; labels only, never values. */
  byLabel: Record<string, number>;
}

/**
 * Sanitise `text` for sharing: known values, then pattern rules (with PII), then
 * the default-deny opaque-token filter. Fails closed to a full withhold.
 */
export function sanitizeForShare(text: string, cfg?: RedactConfig): SanitizeResult {
  try {
    // Never let a committed config switch the sharing-time layers off.
    const forced: RedactConfig = { ...cfg, enabled: true, secrets: true };
    const first = redactDetailed(text, forced);
    const opaque = withholdOpaqueTokens(first.text);
    const byLabel = { ...first.byLabel };
    if (opaque.hits > 0) byLabel['opaque-token'] = opaque.hits;
    return { text: opaque.text, hits: first.hits + opaque.hits, byLabel };
  } catch {
    return { text: WITHHELD, hits: 1, byLabel: { 'sanitizer-error': 1 } };
  }
}

/** One thing the independent scanner still sees; never carries the value itself. */
export interface Finding {
  kind: string;
  count: number;
}

/**
 * An independent second opinion over text that has already been sanitised. It
 * shares no code with the layers above on purpose: a bug in one must not be a bug
 * in both. Returns what it still finds (labels and counts only). Any finding means
 * the text must not leave the machine. `structural` is for ids/hashes/paths.
 */
export function scanResidual(
  text: string,
  opts: { structural?: boolean } = {},
): Finding[] {
  const counts = new Map<string, number>();
  const bump = (kind: string, n = 1) => counts.set(kind, (counts.get(kind) ?? 0) + n);
  const stripped = text
    .split(WITHHELD)
    .join('‹')
    .replace(/‹redacted: [a-z-]+›/g, '‹');

  const known = getKnownSecretMatcher().mask(stripped, ' ');
  if (known.hits > 0) bump('known-secret', known.hits);

  const checks: Array<[string, RegExp]> = [
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY/g],
    [
      'provider-prefix',
      /\b(?:sk-|sk_live_|sk_test_|rk_live_|pk_live_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[a-z]-|AKIA|ASIA|AIza|ya29\.|hf_|npm_|SG\.|whsec_|dop_v1_)[A-Za-z0-9_-]{8,}/g,
    ],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./g],
    [
      'assigned-secret',
      /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?[^\s"'<>‹]{6,}/gi,
    ],
    ['url-credentials', /\w+:\/\/[^\s:/@]*:[^\s/@]{3,}@[^\s]+/g],
    ['bearer', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g],
  ];
  for (const [kind, re] of checks) {
    const m = stripped.match(re);
    if (m) bump(kind, m.length);
  }

  // Anything long and random-looking that survived. A deliberately lower bar than
  // the filter that already ran, so this catches what slipped past its tuning.
  // Structural fields (ids, hashes, paths) are checked by the patterns above only:
  // a long hash or id there is expected and is not a leaked key.
  for (const m of opts.structural ? [] : stripped.matchAll(RUN)) {
    const r = trimEdges(m[0]);
    if (r.length < 24 || !/\d/.test(r) || !/[A-Za-z]/.test(r) || shannon(r) < 3.7)
      continue;
    if (ALLOW.some((re) => re.test(r))) continue;
    // Words and numbers glued with separators (`showtail-test-36540-abcdef`,
    // `claude-haiku-4-5`) are names, not keys: every piece is plain letters, plain
    // digits, or too short to mean anything. Judged here on its own, not by sharing
    // the filter's helper, so the two layers stay independent.
    if (
      /[._-]/.test(r) &&
      r
        .split(/[._-]+/)
        .every((p) => p.length < 6 || !(/\d/.test(p) && /[A-Za-z]/.test(p)))
    ) {
      continue;
    }
    // A file/content hash shown as `sha256:<hex>` is ordinary report content.
    const before = stripped.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
    if (/^[0-9a-f]{64}$/i.test(r) && /sha(?:256)?:?$/i.test(before)) continue;
    bump('opaque-token');
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
