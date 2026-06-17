/**
 * A small content-addressed object store, the home for the heavy content a
 * trail captures: prompt text, AI responses, and code diffs. Each piece of
 * content is written once under a filename derived from its own hash, so:
 *
 *  - identical content is stored exactly once (dedup — a re-saved file or a
 *    repeated AI answer costs nothing extra);
 *  - the journal stays small (it references content by hash, never inlines it);
 *  - a hand-edited object no longer matches its address, so tampering shows.
 *
 * Files are sharded under a two-character prefix (`objects/ab/cdef…`) so no one
 * directory holds a huge number of files — the same trick git uses. Content is
 * plain text (no compression/encryption): findable, but not laid out so a
 * student can casually open one file and see a whole conversation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256OfString } from './hash.ts';
import type { ShowtailPaths } from './storage.ts';

/** Addresses are namespaced by algorithm so a future hash change can coexist. */
const ALGO = 'sha256';

/**
 * Process-lifetime cache of resolved objects. Safe because objects are
 * immutable: once written under a hash, their bytes never change. Keeps a
 * report (which resolves many refs, some repeated) from re-reading the disk.
 */
const cache = new Map<string, string>();

/** Split an address (`sha256:abcd…`) into its hex digest. */
function digestOf(ref: string): string {
  const i = ref.indexOf(':');
  return i === -1 ? ref : ref.slice(i + 1);
}

/** Absolute path to the file backing an object address. */
function objectPath(paths: ShowtailPaths, ref: string): string {
  const hex = digestOf(ref);
  return join(paths.objectsDir, hex.slice(0, 2), hex.slice(2));
}

/**
 * Store `content` and return its address. A no-op on disk if an object with the
 * same content already exists (dedup).
 */
export function writeObject(paths: ShowtailPaths, content: string): string {
  const hex = sha256OfString(content);
  const ref = `${ALGO}:${hex}`;
  const file = objectPath(paths, ref);
  if (!existsSync(file)) {
    mkdirSync(join(paths.objectsDir, hex.slice(0, 2)), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  cache.set(ref, content);
  return ref;
}

/** Resolve an object address back to its content, or null if it's missing. */
export function readObject(paths: ShowtailPaths, ref: string): string | null {
  const cached = cache.get(ref);
  if (cached !== undefined) return cached;
  const file = objectPath(paths, ref);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf8');
  cache.set(ref, content);
  return content;
}
