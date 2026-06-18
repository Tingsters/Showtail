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

export interface RedactResult {
  text: string;
  /** How many sensitive values were replaced. */
  hits: number;
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

/** Provider keys, private keys, tokens, connection strings, passwords. */
const SECRET_RULES: Rule[] = [
  {
    label: 'private-key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
  },
  { label: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'stripe-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  {
    label: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  { label: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{12,}=*)/g, valueGroup: 1 },
  // user:pass@host inside a URL (connection strings, basic-auth links).
  { label: 'credentials', re: /\/\/[^\s:/@]+:([^\s:/@]+)@/g, valueGroup: 1 },
  // key = "value" / "password": "value" style assignments.
  {
    label: 'secret',
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;]{3,})["']?/gi,
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
  { label: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
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
    if (allow.some((a) => a.length > 0 && (match.includes(a) || value.includes(a)))) {
      return match;
    }
    if (rule.check && !rule.check(value)) return match;
    onHit();
    const placeholder = `‹redacted: ${rule.label}›`;
    return rule.valueGroup ? match.replace(value, placeholder) : placeholder;
  });
}

/**
 * Scrub `text` of secrets and PII according to `cfg` (all categories on by
 * default). Returns the cleaned text and the number of values replaced.
 */
export function redact(text: string, cfg?: RedactConfig): RedactResult {
  if (cfg?.enabled === false) return { text, hits: 0 };

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

  let hits = 0;
  let out = text;
  for (const rule of rules) {
    out = applyRule(out, rule, allow, () => {
      hits += 1;
    });
  }
  return { text: out, hits };
}
