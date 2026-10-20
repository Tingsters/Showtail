/**
 * The submission: the sanitised report a student hands in (or attaches to a pull
 * request), plus a signed manifest that makes it tamper-evident.
 *
 * Layout, written under `<project>/showtail-submission/` (deliberately outside the
 * private, self-ignoring `.showtail/`):
 *
 *   report.html     the report, rendered from sanitised data
 *   report.md       the same report as Markdown
 *   manifest.json   what was produced: file hashes, counts, what was withheld
 *   manifest.sig    an ed25519 signature over manifest.json
 *
 * The signing key is generated on first use and lives in Showtail's private,
 * machine-level folder (never in a repo). The public key travels in the manifest,
 * so anyone can check that the files are unchanged since they were signed. That
 * proves *integrity* (nothing was edited after `submit`), not identity: it cannot
 * say who holds the key. Say so plainly wherever it is shown.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { showtailHome } from './globalConfig.ts';
import { scanResidual } from './sanitize.ts';
import { SHOWTAIL_VERSION } from './version.ts';

export const SUBMISSION_DIR = 'showtail-submission';
export const MANIFEST_FILE = 'manifest.json';
export const SIGNATURE_FILE = 'manifest.sig';
const REPORT_FILES = ['report.html', 'report.md'] as const;

export interface SubmissionManifest {
  format: 1;
  tool: 'showtail';
  version: string;
  createdAt: string;
  /** Whose work this covers (a display name), or null for a team report. */
  scope: string | null;
  /** sha256 of each file in the submission, by file name. */
  files: Record<string, string>;
  summary: { sessions: number; events: number; artifacts: number; turns: number };
  /** What the sanitiser removed. Labels and counts only, never values. */
  withheld: { total: number; byLabel: Record<string, number> };
  /** The independent scan that ran before anything was written. */
  scan: { scanner: string; findings: number };
  /** PEM of the signing public key (`keyId` is its short fingerprint). */
  publicKey: string;
  keyId: string;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface StoredKey {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

function keyFile(): string {
  return join(showtailHome(), 'signing-key.json');
}

/** The student's signing key pair, created (owner-only) the first time it is needed. */
export function loadOrCreateSigningKey(): StoredKey {
  const file = keyFile();
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredKey;
      if (stored.privateKey && stored.publicKey) return stored;
    } catch {
      // Fall through and mint a fresh key rather than failing a submission.
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const stored: StoredKey = {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(showtailHome(), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(file, 0o600);
  } catch {
    // No POSIX modes (Windows): the profile ACL applies.
  }
  return stored;
}

export function keyIdOf(publicKeyPem: string): string {
  return sha256(publicKeyPem.trim()).slice(0, 16);
}

export interface SubmissionInput {
  html: string;
  markdown: string;
  scope: string | null;
  summary: SubmissionManifest['summary'];
  withheld: SubmissionManifest['withheld'];
  scanFindings: number;
}

/** Build and sign the manifest for the given rendered files (does not write). */
export function buildManifest(input: SubmissionInput): {
  manifest: SubmissionManifest;
  manifestJson: string;
  signature: string;
} {
  const key = loadOrCreateSigningKey();
  const manifest: SubmissionManifest = {
    format: 1,
    tool: 'showtail',
    version: SHOWTAIL_VERSION,
    createdAt: new Date().toISOString(),
    scope: input.scope,
    files: {
      'report.html': sha256(input.html),
      'report.md': sha256(input.markdown),
    },
    summary: input.summary,
    withheld: input.withheld,
    scan: { scanner: 'showtail-residual-1', findings: input.scanFindings },
    publicKey: key.publicKey,
    keyId: keyIdOf(key.publicKey),
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const signature = cryptoSign(
    null,
    Buffer.from(manifestJson),
    createPrivateKey(key.privateKey),
  );
  return { manifest, manifestJson, signature: signature.toString('base64') };
}

/** Write the submission folder. Returns its path. */
export function writeSubmission(
  root: string,
  input: SubmissionInput,
): {
  dir: string;
  manifest: SubmissionManifest;
} {
  const dir = join(root, SUBMISSION_DIR);
  mkdirSync(dir, { recursive: true });
  const { manifest, manifestJson, signature } = buildManifest(input);
  writeFileSync(join(dir, 'report.html'), input.html, 'utf8');
  writeFileSync(join(dir, 'report.md'), input.markdown, 'utf8');
  writeFileSync(join(dir, MANIFEST_FILE), manifestJson, 'utf8');
  writeFileSync(join(dir, SIGNATURE_FILE), signature + '\n', 'utf8');
  return { dir, manifest };
}

export interface SubmissionCheck {
  ok: boolean;
  problems: string[];
  manifest?: SubmissionManifest;
}

/**
 * Check a submission folder: the signature, each file's hash, and a fresh scan of
 * the Markdown for anything that looks like a secret. Integrity only: it shows the
 * files are unchanged since they were signed, not who signed them.
 */
export function verifySubmission(dir: string): SubmissionCheck {
  const problems: string[] = [];
  const manifestPath = join(dir, MANIFEST_FILE);
  const sigPath = join(dir, SIGNATURE_FILE);
  if (!existsSync(manifestPath) || !existsSync(sigPath)) {
    return { ok: false, problems: ['manifest.json or manifest.sig is missing'] };
  }
  const manifestBytes = readFileSync(manifestPath);
  let manifest: SubmissionManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as SubmissionManifest;
  } catch {
    return { ok: false, problems: ['manifest.json is not valid JSON'] };
  }

  try {
    const valid = cryptoVerify(
      null,
      manifestBytes,
      createPublicKey(manifest.publicKey),
      Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64'),
    );
    if (!valid) problems.push('the manifest signature does not match (it was changed)');
  } catch {
    problems.push('the manifest signature could not be checked');
  }
  if (manifest.keyId !== keyIdOf(manifest.publicKey ?? '')) {
    problems.push('the manifest key id does not match its public key');
  }

  for (const name of REPORT_FILES) {
    const file = join(dir, name);
    const expected = manifest.files?.[name];
    if (!expected) {
      problems.push(`${name} is not listed in the manifest`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${name} is missing`);
      continue;
    }
    if (sha256(readFileSync(file)) !== expected)
      problems.push(`${name} was changed after signing`);
  }

  // A fresh look at the text, with the patterns and known values (not the opaque
  // filter, which already ran over the data this was rendered from).
  const mdFile = join(dir, 'report.md');
  if (existsSync(mdFile)) {
    const findings = scanResidual(readFileSync(mdFile, 'utf8'), { structural: true });
    if (findings.length > 0) {
      problems.push(
        `report.md still contains what looks like a secret (${findings
          .map((f) => `${f.kind} x${f.count}`)
          .join(', ')})`,
      );
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}
