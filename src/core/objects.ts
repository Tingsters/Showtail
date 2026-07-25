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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * The address `content` would be stored under, without writing anything. Lets a
 * caller (e.g. `showtail redact --dry-run`) work out where rewritten content
 * *would* land while staying strictly read-only.
 */
export function addressOf(content: string): string {
  return `${ALGO}:${sha256OfString(content)}`;
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

/** Whether an object exists on disk for this address (ignores the cache). */
export function objectExists(paths: ShowtailPaths, ref: string): boolean {
  return existsSync(objectPath(paths, ref));
}

/**
 * Delete a stored object and forget it, returning whether a file was removed.
 *
 * Objects are immutable, so nothing else in Showtail deletes one — the single
 * caller is `showtail redact`, which rewrites content to a new address and then
 * drops the address the leaked text lived at. Dropping the {@link cache} entry is
 * the load-bearing half: the cache exists *because* objects never change, so a
 * removal that skipped it would keep serving the very text just scrubbed for the
 * rest of the process (and to every later assertion in a test run).
 */
export function removeObject(paths: ShowtailPaths, ref: string): boolean {
  cache.delete(ref);
  const file = objectPath(paths, ref);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** The verdict for one stored object (see {@link checkObjects}). */
export interface ObjectCheck {
  /** The object's address, as the journal would reference it (`sha256:…`). */
  ref: string;
  /** `ok` — content still hashes to its address; `mismatch` — it was edited. */
  status: 'ok' | 'mismatch' | 'missing';
}

/**
 * Re-hash every stored object and report any whose content no longer matches
 * its address. This is the check that makes the store's central promise real:
 * prompt text and AI replies live here, so a student who hand-edits an object to
 * invent a prompt they never wrote changes its content without being able to
 * change the filename it is stored under — and it shows up here as a `mismatch`.
 *
 * Reads straight from disk, deliberately bypassing the in-process {@link cache}:
 * the cache is keyed by ref and would hand back the value that was just written,
 * verifying nothing.
 */
export function checkObjects(paths: ShowtailPaths): ObjectCheck[] {
  const out: ObjectCheck[] = [];
  if (!existsSync(paths.objectsDir)) return out;
  for (const shard of readdirSync(paths.objectsDir).sort()) {
    // Only the two-character shard dirs hold objects; ignore anything else.
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    const shardDir = join(paths.objectsDir, shard);
    let names: string[];
    try {
      names = readdirSync(shardDir).sort();
    } catch {
      continue; // Not a directory (defensive) — skip.
    }
    for (const name of names) {
      const hex = shard + name;
      const ref = `${ALGO}:${hex}`;
      let content: string;
      try {
        content = readFileSync(join(shardDir, name), 'utf8');
      } catch {
        // Listed but unreadable (removed mid-walk, or not a regular file).
        out.push({ ref, status: 'missing' });
        continue;
      }
      out.push({ ref, status: sha256OfString(content) === hex ? 'ok' : 'mismatch' });
    }
  }
  return out;
}
