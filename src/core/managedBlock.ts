/**
 * Generic "managed block" machinery shared by the integrations that write into
 * a file the user also owns (GitHub Copilot's instructions, Codex's AGENTS.md).
 *
 * A managed block is delimited by markers; the START marker carries a short
 * fingerprint of the exact text Showtail wrote, so we can tell an untouched
 * (possibly old) block from one a human edited — and only ever overwrite our
 * own content. Anything outside the markers is the user's and is never touched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256OfString } from './hash.ts';

export const MARKER_END = '<!-- showtail:end -->';
export const START_RE = /<!-- showtail:start(?: sha=([0-9a-f]+))? -->/;

/** Short content fingerprint stamped into the start marker. */
export function shortHash(text: string): string {
  return sha256OfString(text.trim()).slice(0, 12);
}

export function blockFor(body: string): string {
  const inner = body.trim();
  return `<!-- showtail:start sha=${shortHash(inner)} -->\n${inner}\n${MARKER_END}`;
}

export interface ParsedBlock {
  inner: string;
  /** The stamped fingerprint, or undefined for a legacy (pre-fingerprint) block. */
  sha: string | undefined;
  startIndex: number;
  endIndex: number;
}

export function parseBlock(content: string): ParsedBlock | null {
  const m = START_RE.exec(content);
  if (!m || m.index === undefined) return null;
  const startEnd = m.index + m[0].length;
  const endIdx = content.indexOf(MARKER_END, startEnd);
  if (endIdx === -1) return null;
  return {
    inner: content.slice(startEnd, endIdx).trim(),
    sha: m[1],
    startIndex: m.index,
    endIndex: endIdx + MARKER_END.length,
  };
}

export type BlockClass = 'uptodate' | 'stale' | 'edited';

export function classify(parsed: ParsedBlock, latestBody: string): BlockClass {
  const latest = latestBody.trim();
  if (parsed.sha === undefined) {
    // Legacy block with no fingerprint: pre-fingerprint Showtail always
    // overwrote it, so no respected edit can exist — treat as untouched.
    return parsed.inner === latest ? 'uptodate' : 'stale';
  }
  if (shortHash(parsed.inner) !== parsed.sha) return 'edited';
  return parsed.inner === latest ? 'uptodate' : 'stale';
}

// --- YAML frontmatter handling ---------------------------------------------
// Some hosts (Copilot's path-specific instructions) require frontmatter at the
// very top, so it sits OUTSIDE the managed block as a small preamble; the body
// is what Showtail manages/fingerprints. Files without frontmatter pass ''.

export function splitFrontmatter(text: string): { preamble: string; body: string } {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  if (m) return { preamble: m[0].trimEnd(), body: text.slice(m[0].length).trim() };
  return { preamble: '', body: text.trim() };
}

/**
 * Install or refresh a managed block in `file`. Only ever overwrites content
 * Showtail itself wrote: untouched blocks update to the latest, user-edited
 * blocks are left alone (unless `force`), and anything outside the block is
 * always preserved. `preamble` is optional frontmatter that sits above the block.
 */
export function applyManagedBlock(
  file: string,
  latestBody: string,
  preamble: string,
  force: boolean,
): void {
  const block = blockFor(latestBody);
  let next: string;

  if (!existsSync(file)) {
    next = preamble ? `${preamble}\n\n${block}\n` : `${block}\n`;
  } else {
    const current = readFileSync(file, 'utf8');
    const parsed = parseBlock(current);
    if (parsed) {
      const cls = classify(parsed, latestBody);
      // Keep user edits (and skip no-op updates) unless forced.
      next =
        !force && (cls === 'edited' || cls === 'uptodate')
          ? current
          : current.slice(0, parsed.startIndex) + block + current.slice(parsed.endIndex);
    } else if (preamble) {
      // Markerless file with a preamble: migrate the old wholesale content to
      // block form; otherwise it's the user's own file — respect it.
      const legacy = `${preamble}\n\n${latestBody.trim()}`.trim();
      next =
        current.trim() === legacy || current.trim() === latestBody.trim()
          ? `${preamble}\n\n${block}\n`
          : current;
    } else {
      // A pre-existing user file without our block: append it.
      next = current.trimEnd() + '\n\n' + block + '\n';
    }
  }

  writeIfChanged(file, next);
}

/** Write only when content differs (no churn / no editor "changed on disk"). */
export function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  writeFileSync(file, content, 'utf8');
}

/**
 * Remove a managed block from `file`. Returns true if a block was found and
 * removed. If stripping the block empties the file, it is deleted by the
 * caller-supplied `onEmpty`; otherwise the trimmed remainder is written back.
 */
export function stripManagedBlock(file: string, onEmpty: () => void): boolean {
  if (!existsSync(file)) return false;
  const current = readFileSync(file, 'utf8');
  const parsed = parseBlock(current);
  if (!parsed) return false;
  const stripped = (current.slice(0, parsed.startIndex) + current.slice(parsed.endIndex))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped.length === 0) {
    onEmpty();
  } else {
    writeFileSync(file, stripped + '\n', 'utf8');
  }
  return true;
}
