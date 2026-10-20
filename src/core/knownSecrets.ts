/**
 * Known-value masking: redact the student's *actual* secrets, whatever they look
 * like.
 *
 * Pattern redaction can only recognise formats someone has already written a rule
 * for, and providers change their key formats constantly. But the machine already
 * knows which secrets it holds: they are in the environment, in the project's
 * `.env` files, and in the standard credential files (`~/.aws/credentials`,
 * `~/.npmrc`, …). So we read those *values* and mask every exact occurrence, in
 * every encoding it might be pasted in. That works for a key format invented
 * tomorrow. (It is the model CI systems use to mask secrets in build logs.)
 *
 * Values are held in memory only and never written anywhere.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Never treat values shorter than this as secret: too many false positives. */
const MIN_LENGTH = 8;
/** A hard cap so a pathological environment cannot make matching slow. */
const MAX_VALUES = 400;

/** Env var names that suggest a secret. Strong names accept any value. */
const STRONG_NAME =
  /(?:secret|token|passw|pwd|api[_-]?key|apikey|private|credential|signature)/i;
/** Weaker names need a value that looks random (see {@link looksRandom}). */
const WEAK_NAME = /(?:key|auth|cert|session|cookie|dsn|webhook)/i;

const TRIVIAL = new Set([
  'true',
  'false',
  'null',
  'none',
  'undefined',
  'localhost',
  'production',
  'development',
  'staging',
  'default',
  'password',
  'changeme',
]);

/** A path, not a secret (SSH_AUTH_SOCK, XAUTHORITY, …). */
function looksLikePath(v: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|~|\.\.?[\\/])/.test(v) && !/\s/.test(v);
}

/** Has the variety of a generated secret rather than being a plain word. */
function looksRandom(v: string): boolean {
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /[^A-Za-z0-9]/.test(v);
}

function acceptable(name: string | undefined, value: string): boolean {
  const v = value.trim();
  if (v.length < MIN_LENGTH || TRIVIAL.has(v.toLowerCase()) || looksLikePath(v))
    return false;
  if (/^(.)\1+$/.test(v)) return false; // "xxxxxxxx", "00000000"
  if (name === undefined) return true; // a .env file's values are all fair game
  if (STRONG_NAME.test(name)) return true;
  return WEAK_NAME.test(name) && looksRandom(v);
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  // An inline comment on an unquoted value.
  return v.replace(/\s+#.*$/, '');
}

/** `KEY=value` / `export KEY="value"` lines from a dotenv-style file. */
function parseDotenv(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = unquote(m[2]!);
    if (acceptable(undefined, value)) out.push(value);
  }
  return out;
}

/**
 * Values from the standard credential files, which are INI/YAML/rc-ish rather than
 * dotenv: `aws_secret_access_key = …`, `//registry/:_authToken=…`, `password …`,
 * `oauth_token: …`, and `https://user:pass@host` in `.git-credentials`.
 */
function parseCredentialFile(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const kv =
      /(?:key|token|secret|pass(?:word)?|auth)[A-Za-z0-9_.-]*["']?\s*[:=\s]\s*["']?([^\s"'#]{8,})/i.exec(
        line,
      );
    if (kv && acceptable('token', kv[1]!)) out.push(kv[1]!);
    const url = /\/\/[^\s:/@]+:([^\s/@]+)@/.exec(line);
    if (url && acceptable(undefined, decodeURIComponentSafe(url[1]!))) {
      out.push(decodeURIComponentSafe(url[1]!));
    }
  }
  return out;
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function readSmall(file: string, maxBytes = 256 * 1024): string | undefined {
  try {
    if (!existsSync(file) || statSync(file).size > maxBytes) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Dotenv files in `dir`: `.env`, `.env.local`, `.env.production`, … */
function dotenvFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^\.env(?:\..+)?$/i.test(n))
      .filter((n) => !/\.(?:example|sample|template|dist)$/i.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

const CREDENTIAL_FILES = [
  ['.aws', 'credentials'],
  ['.npmrc'],
  ['.pypirc'],
  ['.netrc'],
  ['_netrc'],
  ['.git-credentials'],
  ['.config', 'gh', 'hosts.yml'],
  ['.docker', 'config.json'],
  ['.config', 'gcloud', 'application_default_credentials.json'],
];

export interface HarvestOptions {
  env?: NodeJS.ProcessEnv;
  /** Project directories whose `.env*` files should be read. */
  dirs?: string[];
  home?: string;
}

/** The distinct raw secret values this machine/project holds. */
export function harvestSecretValues(options: HarvestOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const found = new Set<string>();

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && acceptable(name, value)) found.add(value.trim());
  }
  for (const dir of options.dirs ?? [process.cwd()]) {
    for (const file of dotenvFiles(dir)) {
      const text = readSmall(file);
      if (text) for (const v of parseDotenv(text)) found.add(v);
    }
  }
  for (const parts of CREDENTIAL_FILES) {
    const text = readSmall(join(home, ...parts));
    if (text) for (const v of parseCredentialFile(text)) found.add(v);
  }
  return [...found].slice(0, MAX_VALUES);
}

function b64(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64');
}

/**
 * Every form `value` might appear in once pasted into a prompt, a URL, a JSON
 * blob or a header: raw, URL-encoded, base64 / base64url, JSON-escaped, and (for a
 * long value) its first and last 12 characters, so a truncated paste still matches.
 */
export function encodedVariants(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(encodeURIComponent(value));
  const b = b64(value);
  out.add(b);
  out.add(b.replace(/=+$/, ''));
  out.add(b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  out.add(JSON.stringify(value).slice(1, -1));
  if (value.length >= 20) {
    out.add(value.slice(0, 12));
    out.add(value.slice(-12));
  }
  return [...out].filter((s) => s.length >= MIN_LENGTH);
}

export interface KnownSecretMatcher {
  /** Replace every occurrence with `placeholder`; returns the text and hit count. */
  mask(text: string, placeholder: string): { text: string; hits: number };
  /** Number of distinct strings being matched. */
  size: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a set of raw secret values into one matcher (longest alternatives first). */
export function buildMatcher(values: string[]): KnownSecretMatcher {
  const variants = new Set<string>();
  for (const v of values) for (const form of encodedVariants(v)) variants.add(form);
  const sorted = [...variants].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) {
    return { size: 0, mask: (text) => ({ text, hits: 0 }) };
  }
  const re = new RegExp(sorted.map(escapeRegex).join('|'), 'g');
  return {
    size: sorted.length,
    mask(text, placeholder) {
      let hits = 0;
      const out = text.replace(re, () => {
        hits += 1;
        return placeholder;
      });
      return { text: out, hits };
    },
  };
}

let cached: { key: string; matcher: KnownSecretMatcher } | undefined;

/**
 * The process-wide matcher for this machine, built lazily from the environment and
 * the working directory's `.env*` files, then reused. Hooks are short-lived
 * processes, so one harvest per process is both cheap and fresh.
 */
export function getKnownSecretMatcher(): KnownSecretMatcher {
  const key = process.cwd();
  if (cached?.key !== key) {
    let values: string[] = [];
    try {
      values = harvestSecretValues();
    } catch {
      // Harvesting is best-effort; the pattern rules still run.
    }
    cached = { key, matcher: buildMatcher(values) };
  }
  return cached.matcher;
}

/** Test seam: replace (or clear, with `undefined`) the cached process-wide matcher. */
export function setKnownSecretValues(values: string[] | undefined): void {
  cached =
    values === undefined
      ? undefined
      : { key: process.cwd(), matcher: buildMatcher(values) };
}
