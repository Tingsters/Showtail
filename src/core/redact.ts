/**
 * Best-effort scrubbing of secrets and personal data from captured content,
 * applied *before* anything is written to disk so a teacher never receives a
 * student's passwords, API keys, or sensitive personal data. This is a safety
 * net, not a guarantee: it can miss novel formats and may occasionally over- or
 * under-redact. The `allow` and `custom` config knobs exist to tune it.
 *
 * Detection is a curated, zero-dependency rule library (no entropy guessing, to
 * avoid over-redaction). Each hit becomes a labeled placeholder like
 * `‹redacted: api-key›`, so the surrounding text still reads naturally.
 */
import type { RedactConfig } from '../types.ts';
import { getKnownSecretMatcher } from './knownSecrets.ts';

export interface RedactResult {
  text: string;
  /** How many sensitive values were replaced. */
  hits: number;
}

/**
 * A {@link RedactResult} that also says *which* rules fired. `showtail redact`
 * records the labels (never the values) on its audit marker, so a reader can see
 * an after-the-fact pass removed, say, an `api-key` without learning the key.
 */
export interface DetailedRedactResult extends RedactResult {
  /** Values replaced per rule label; only labels that actually hit appear. */
  byLabel: Record<string, number>;
}

/**
 * A caller-supplied rule applied on top of (or instead of) the built-ins — how
 * `showtail redact --pattern <regex>` scrubs one specific thing a student knows
 * leaked, without reimplementing the matching engine.
 */
export interface ExtraRule {
  /** The label that appears in the placeholder and on the audit marker. */
  label: string;
  /** Regex source, compiled with the `g` flag. Invalid sources are ignored. */
  source: string;
}

interface Rule {
  label: string;
  re: RegExp;
  /** 1-based capture group holding the sensitive value (else the whole match). */
  valueGroup?: number;
  /** Extra predicate the value must pass to count as sensitive (e.g. Luhn). */
  check?: (value: string) => boolean;
}

/** Luhn checksum — keeps random 16-digit ids from looking like card numbers. */
function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Names that mark a value as sensitive. Matched as a *substring of an
 * identifier* (`DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `clientSecret`), not as a
 * whole word: `\b` never matches between `_` and a letter, which is how
 * `.env`-style names used to slip through.
 */
// Start only at the beginning of an identifier run. `\b` would restart the
// greedy prefix at every `.`/`-` boundary and rescan the run: quadratic on long
// dotted text.
const KEYWORD_START = '(?<![A-Za-z0-9_.-])';
const KEYWORD =
  '[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?:orization)?)[A-Za-z0-9_.-]*';

/** Provider keys, private keys, tokens, connection strings, passwords. */
const SECRET_RULES: Rule[] = [
  {
    label: 'private-key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
  },
  // A block whose END marker is missing (truncated diff, `head -5 key.pem`):
  // everything after BEGIN is key material, so withhold it to the end of the text.
  { label: 'private-key', re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*$/g },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g },
  { label: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    label: 'slack-webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  },
  { label: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { label: 'stripe-key', re: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'google-oauth', re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { label: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { label: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { label: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { label: 'twilio-key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { label: 'digitalocean-token', re: /\bdo[opr]_v1_[a-f0-9]{40,}\b/g },
  {
    label: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  { label: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{8,}=*)/gi, valueGroup: 1 },
  { label: 'basic-auth', re: /\bBasic\s+([A-Za-z0-9+/]{8,}=*)/g, valueGroup: 1 },
  // user:pass@host inside a URL. The password may itself contain ':' or '@'
  // (greedy up to the last '@' before the host), and the user may be empty.
  { label: 'credentials', re: /\/\/[^\s:/@]*:([^\s/]+)@(?=[^\s@]+)/g, valueGroup: 1 },
  // Azure storage / shared-access secrets.
  {
    label: 'azure-key',
    re: /\b(?:AccountKey|SharedAccessKey|sig)=([A-Za-z0-9+/%]{20,}=*)/g,
    valueGroup: 1,
  },
  // KEY = "value" / password: 'value' / SECRET_KEY=value. Quoted values may hold
  // spaces (passphrases); unquoted ones run to the next delimiter.
  {
    label: 'secret',
    re: new RegExp(`${KEYWORD_START}${KEYWORD}["']?\\s*[:=]\\s*"([^"\\n]{3,})"`, 'gi'),
    valueGroup: 1,
  },
  {
    label: 'secret',
    re: new RegExp(`${KEYWORD_START}${KEYWORD}["']?\\s*[:=]\\s*'([^'\\n]{3,})'`, 'gi'),
    valueGroup: 1,
  },
  {
    label: 'secret',
    re: new RegExp(`${KEYWORD_START}${KEYWORD}["']?\\s*[:=]\\s*([^\\s"',;]{3,})`, 'gi'),
    valueGroup: 1,
  },
  // "my password is hunter2", "the pin: 1234"
  {
    label: 'password',
    re: /\b(?:password|passcode|passphrase|pin)\s+(?:is|was|=|:)\s+(\S{3,})/gi,
    valueGroup: 1,
  },
];

/** Common personally-identifying information. */
const PII_RULES: Rule[] = [
  // Anchored at the start of a run of local-part characters: unanchored, the
  // engine rescans the whole run from every position, which is quadratic on a
  // long token with no '@' (1MB of it never finished).
  {
    label: 'email',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    label: 'credit-card',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    check: luhnValid,
  },
  {
    label: 'phone',
    re: /\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
];

/** Apply one rule, redacting matches that aren't allow-listed and pass `check`. */
function applyRule(text: string, rule: Rule, allow: string[], onHit: () => void): string {
  return text.replace(rule.re, (...args: string[]) => {
    const match = args[0]!;
    // args = [match, ...groups, offset, fullString]; groups are the middle.
    const groups = args.slice(1, -2);
    const value = rule.valueGroup ? groups[rule.valueGroup - 1] : match;
    if (value == null) return match;
    // Never re-redact a placeholder (the keyword rules would otherwise re-match
    // `password="‹redacted: secret›"` and mangle it).
    if (value.includes('‹redacted:')) return match;
    // Exact match only: a substring test let a short allow entry ("a") switch
    // redaction off for every match that happened to contain it.
    if (allow.some((a) => a.length > 0 && (match === a || value === a))) return match;
    if (rule.check && !rule.check(value)) return match;
    onHit();
    const placeholder = `‹redacted: ${rule.label}›`;
    if (!rule.valueGroup) return placeholder;
    // Replace the value where it sits: `match.replace(value, …)` hit the *first*
    // occurrence, so `password=pass` became `‹redacted›word=pass`.
    const at = match.lastIndexOf(value);
    return match.slice(0, at) + placeholder + match.slice(at + value.length);
  });
}

/**
 * Scrub `text` of secrets and PII according to `cfg` (all categories on by
 * default), reporting a per-label breakdown as well as the total.
 *
 * `extra` appends caller-supplied rules — the hook `showtail redact --pattern`
 * uses so an after-the-fact scrub goes through this same engine (allow-list,
 * placeholder shape, capture-group handling) instead of its own matcher.
 */
export function redactDetailed(
  text: string,
  cfg?: RedactConfig,
  extra?: ExtraRule[],
): DetailedRedactResult {
  if (cfg?.enabled === false) return { text, hits: 0, byLabel: {} };

  const allow = cfg?.allow ?? [];
  const rules: Rule[] = [];
  if (cfg?.secrets !== false) rules.push(...SECRET_RULES);
  if (cfg?.pii !== false) rules.push(...PII_RULES);
  for (const src of cfg?.custom ?? []) {
    try {
      rules.push({ label: 'custom', re: new RegExp(src, 'g') });
    } catch {
      // A malformed custom pattern is ignored rather than crashing capture.
    }
  }
  for (const { label, source } of extra ?? []) {
    try {
      rules.push({ label, re: new RegExp(source, 'g') });
    } catch {
      // Same policy as `custom`: a bad pattern never breaks the caller. The
      // `redact` command validates its own `--pattern` up front and errors there.
    }
  }

  let hits = 0;
  const byLabel: Record<string, number> = {};
  let out = text;
  // First, mask the student's own known secret values (env vars, .env files,
  // credential files), whatever format they are in. This is the layer that does not
  // depend on recognising a key's shape; the pattern rules below are the fallback.
  if (cfg?.secrets !== false) {
    const known = getKnownSecretMatcher().mask(out, '‹redacted: known-secret›');
    if (known.hits > 0) {
      out = known.text;
      hits += known.hits;
      byLabel['known-secret'] = known.hits;
    }
  }
  for (const rule of rules) {
    out = applyRule(out, rule, allow, () => {
      hits += 1;
      byLabel[rule.label] = (byLabel[rule.label] ?? 0) + 1;
    });
  }
  return { text: out, hits, byLabel };
}

/**
 * Scrub `text` of secrets and PII according to `cfg` (all categories on by
 * default). Returns the cleaned text and the number of values replaced.
 */
export function redact(text: string, cfg?: RedactConfig): RedactResult {
  const { text: out, hits } = redactDetailed(text, cfg);
  return { text: out, hits };
}
