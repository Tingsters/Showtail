/**
 * Files whose *contents* must never enter a trail, whatever redaction would
 * have made of them. A secret file is the highest-risk thing an agent can
 * touch: when an agent writes `.env` or `~/.aws/credentials`, the whole file
 * would otherwise be stored as an all-`+` diff, and pattern redaction can only
 * ever guess which lines are secret. So these are never captured at all — no
 * diff, and no content hash (a hash of a low-entropy secret file can be
 * brute-forced). Edits outside the project root are skipped for the same reason:
 * they are not part of the student's project, and they carry the home path.
 */
import { isAbsolute, relative, sep } from 'node:path';

/** Whole-basename matches (case-insensitive). */
const SENSITIVE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '.dockercfg',
  '.boto',
  '.pgpass',
  '.my.cnf',
  'credentials',
  'credentials.json',
  'kubeconfig',
  'terraform.tfvars',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
  'secret.json',
  'secret.yml',
  'secret.yaml',
]);

/** Basename patterns. */
const SENSITIVE_PATTERNS: RegExp[] = [
  // `.env`, `.env.local`, `.env.production` — but not the placeholder templates.
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|gpg|asc|kdbx|ppk)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_.*)?$/i,
  /\.tfstate(?:\..*)?$/i,
  /\.tfvars$/i,
  /(?:^|[-_.])service[-_]?account.*\.json$/i,
  /[-_]credentials?\.json$/i,
  /^client_secrets?.*\.json$/i,
];

/** Placeholder templates people legitimately commit and share. */
const SAFE_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults?)$/i;

/** Directories whose entire contents are credential material. */
const SENSITIVE_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.password-store',
]);

/** Directory pairs (parent/child) that mark credential stores. */
const SENSITIVE_DIR_PAIRS: Array<[string, string]> = [
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  ['.docker', 'config.json'],
];

/** True when the file's contents must never be captured. */
export function isSensitivePath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  const base = (parts[parts.length - 1] ?? '').toLowerCase();
  if (!base) return false;
  if (SAFE_TEMPLATE.test(base)) return false;
  if (SENSITIVE_NAMES.has(base)) return true;
  if (SENSITIVE_PATTERNS.some((re) => re.test(base))) return true;
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (dirs.some((d) => SENSITIVE_DIRS.has(d))) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    for (const [a, b] of SENSITIVE_DIR_PAIRS) {
      if (parts[i]!.toLowerCase() === a && parts[i + 1]!.toLowerCase() === b) return true;
    }
  }
  return false;
}

/** True when `abs` is not inside `root` (or lies on a different drive). */
export function isOutsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Whether an edit to `abs` may be captured: the file must live under `root` and
 * must not be a credential file. Fails closed on the sensitive-name check.
 */
export function isCapturablePath(root: string, abs: string): boolean {
  return !isOutsideRoot(root, abs) && !isSensitivePath(abs);
}
