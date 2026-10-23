import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Compute the SHA-256 hex digest of a string. */
export function sha256OfString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Compute the SHA-256 hex digest of a Buffer/bytes. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compute the SHA-256 hex digest of a file's contents.
 * Reads the raw bytes so the hash is stable across platforms/encodings.
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return sha256OfBytes(bytes);
}
