import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { showtailHome } from './globalConfig.ts';
import type { Tool } from '../types.ts';

const CLAIM_TTL_MS = 5 * 60_000;

/** Sort object keys recursively so equivalent JSON payloads produce one digest. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function claimsDir(): string {
  return join(showtailHome(), 'hook-claims');
}

/** Remove expired machine-local claims without ever disrupting a host hook. */
function sweepExpiredClaims(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > CLAIM_TTL_MS) rmSync(file, { force: true });
      } catch {
        // Another hook may be creating or sweeping the same claim.
      }
    }
  } catch {
    // Claim cleanup is best-effort.
  }
}

/**
 * Atomically claim one host hook invocation.
 *
 * Copilot CLI executes both user- and project-level hooks. When both contain
 * Showtail, two processes receive the same payload concurrently. The digest is
 * the only persisted value (never prompt text), and exclusive file creation
 * guarantees only one process proceeds. A timestamp in real host payloads keeps
 * two otherwise-identical prompts distinct.
 */
export function claimHookInvocation(tool: Tool, event: string, raw: unknown): boolean {
  try {
    const timestamp =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>).timestamp
        : undefined;
    // Older/hand-written payloads without a host timestamp cannot distinguish a
    // duplicate invocation from a legitimate repeated event, so fail open.
    const hasHostTimestamp =
      (typeof timestamp === 'string' && timestamp.trim().length > 0) ||
      (typeof timestamp === 'number' && Number.isFinite(timestamp));
    if (!hasHostTimestamp) return true;
    const digest = createHash('sha256')
      .update(JSON.stringify(canonicalize({ tool, event, raw })))
      .digest('hex');
    const dir = claimsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, digest);
    const now = Date.now();

    try {
      const fd = openSync(file, 'wx');
      closeSync(fd);
      sweepExpiredClaims(dir, now);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return true; // Capture must fail open on bookkeeping errors.
    }

    try {
      if (now - statSync(file).mtimeMs <= CLAIM_TTL_MS) return false;
      rmSync(file, { force: true });
      const fd = openSync(file, 'wx');
      closeSync(fd);
      sweepExpiredClaims(dir, now);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'EEXIST';
    }
  } catch {
    return true; // Never drop capture because the local claim store is unavailable.
  }
}
