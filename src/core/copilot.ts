import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary.
import COPILOT_INSTRUCTIONS from '../../assets/copilot/copilot-instructions.md' with { type: 'text' };
import SHOWTAIL_PATH_INSTRUCTIONS from '../../assets/copilot/showtail.instructions.md' with { type: 'text' };
import { sha256OfString } from './hash.ts';
import { findRoot } from './storage.ts';

export { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS };

// A managed block is delimited by markers; the START marker carries a short
// fingerprint of the exact text Showtail wrote, so we can tell an untouched
// (possibly old) block from one a human edited — and only ever overwrite our
// own content. Anything outside the markers is the user's and is never touched.
const MARKER_END = '<!-- showtail:end -->';
const START_RE = /<!-- showtail:start(?: sha=([0-9a-f]+))? -->/;

/** Short content fingerprint stamped into the start marker. */
function shortHash(text: string): string {
  return sha256OfString(text.trim()).slice(0, 12);
}

function blockFor(body: string): string {
  const inner = body.trim();
  return `<!-- showtail:start sha=${shortHash(inner)} -->\n${inner}\n${MARKER_END}`;
}

interface ParsedBlock {
  inner: string;
  /** The stamped fingerprint, or undefined for a legacy (pre-fingerprint) block. */
  sha: string | undefined;
  startIndex: number;
  endIndex: number;
}

function parseBlock(content: string): ParsedBlock | null {
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

type BlockClass = 'uptodate' | 'stale' | 'edited';

function classify(parsed: ParsedBlock, latestBody: string): BlockClass {
  const latest = latestBody.trim();
  if (parsed.sha === undefined) {
    // Legacy block with no fingerprint: pre-fingerprint Showtail always
    // overwrote it, so no respected edit can exist — treat as untouched.
    return parsed.inner === latest ? 'uptodate' : 'stale';
  }
  if (shortHash(parsed.inner) !== parsed.sha) return 'edited';
  return parsed.inner === latest ? 'uptodate' : 'stale';
}

// --- YAML frontmatter handling for showtail.instructions.md ----------------
// Copilot requires frontmatter at the very top, so it sits OUTSIDE the managed
// block as a small preamble; the body is what Showtail manages/fingerprints.

function splitFrontmatter(text: string): { preamble: string; body: string } {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  if (m) return { preamble: m[0].trimEnd(), body: text.slice(m[0].length).trim() };
  return { preamble: '', body: text.trim() };
}

const PATH_FM = splitFrontmatter(SHOWTAIL_PATH_INSTRUCTIONS).preamble;
const PATH_BODY = splitFrontmatter(SHOWTAIL_PATH_INSTRUCTIONS).body;

export interface CopilotTarget {
  /** Project root (the folder that holds .github/). */
  root: string;
  githubDir: string;
  /** Repo-wide Copilot custom instructions (applies in Chat). */
  instructionsFile: string;
  /** Path-specific instructions (applies in agent mode). */
  pathInstructionsFile: string;
}

/** Resolve the `.github/` layout for the nearest project root (or cwd). */
export function resolveCopilotTarget(cwd: string = process.cwd()): CopilotTarget {
  const root = findRoot(cwd) ?? cwd;
  const githubDir = join(root, '.github');
  return {
    root,
    githubDir,
    instructionsFile: join(githubDir, 'copilot-instructions.md'),
    pathInstructionsFile: join(githubDir, 'instructions', 'showtail.instructions.md'),
  };
}

export interface WriteOptions {
  /** Overwrite even a user-edited block (take the latest). */
  force?: boolean;
}

/**
 * Install or refresh the Showtail instructions. Only ever overwrites content
 * Showtail itself wrote: untouched blocks update to the latest, user-edited
 * blocks are left alone (unless `force`), and anything outside the block is
 * always preserved.
 */
export function writeCopilotInstructions(
  target: CopilotTarget,
  options: WriteOptions = {},
): void {
  const force = options.force ?? false;
  mkdirSync(target.githubDir, { recursive: true });
  applyManagedBlock(target.instructionsFile, COPILOT_INSTRUCTIONS, '', force);
  mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
  applyManagedBlock(target.pathInstructionsFile, PATH_BODY, PATH_FM, force);
}

function applyManagedBlock(
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
      // Markerless path file: migrate the old wholesale content to block form;
      // otherwise it's the user's own file — respect it.
      const legacy = `${preamble}\n\n${latestBody.trim()}`.trim();
      next =
        current.trim() === legacy || current.trim() === latestBody.trim()
          ? `${preamble}\n\n${block}\n`
          : current;
    } else {
      // A pre-existing user copilot-instructions.md without our block: append it.
      next = current.trimEnd() + '\n\n' + block + '\n';
    }
  }

  writeIfChanged(file, next);
}

/** Write only when content differs (no churn / no editor "changed on disk"). */
function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  writeFileSync(file, content, 'utf8');
}

export interface CopilotState {
  installed: boolean;
  /** All managed blocks are present and current (nothing for Showtail to do). */
  upToDate: boolean;
  /** At least one block was hand-edited (Showtail leaves it alone). */
  userEdited: boolean;
  /** A newer Showtail version exists than what the user forked from / has. */
  updateAvailable: boolean;
}

/** Inspect the installed instructions and classify them for status/refresh. */
export function copilotState(target: CopilotTarget): CopilotState {
  const entries: Array<[string, string]> = [
    [target.instructionsFile, COPILOT_INSTRUCTIONS],
    [target.pathInstructionsFile, PATH_BODY],
  ];
  let installed = false;
  let userEdited = false;
  let updateAvailable = false;
  let allCurrent = true;

  for (const [file, body] of entries) {
    if (!existsSync(file)) {
      allCurrent = false;
      continue;
    }
    const parsed = parseBlock(readFileSync(file, 'utf8'));
    if (!parsed) {
      allCurrent = false;
      continue;
    }
    installed = true;
    const cls = classify(parsed, body);
    if (cls === 'edited') {
      userEdited = true;
      allCurrent = false;
      // The stamp is the version they forked from; an update exists only if a
      // newer one has shipped since.
      if (parsed.sha !== shortHash(body)) updateAvailable = true;
    } else if (cls === 'stale') {
      allCurrent = false;
      updateAvailable = true;
    }
  }

  return { installed, upToDate: installed && allCurrent, userEdited, updateAvailable };
}

/** True when the installed instructions are present and current. */
export function copilotUpToDate(target: CopilotTarget): boolean {
  return copilotState(target).upToDate;
}

/** Remove the Showtail block and our path-specific file. */
export function removeCopilotInstructions(target: CopilotTarget): boolean {
  let touched = false;

  if (existsSync(target.instructionsFile)) {
    const current = readFileSync(target.instructionsFile, 'utf8');
    const parsed = parseBlock(current);
    if (parsed) {
      const stripped = (
        current.slice(0, parsed.startIndex) + current.slice(parsed.endIndex)
      )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (stripped.length === 0) {
        rmSync(target.instructionsFile, { force: true });
      } else {
        writeFileSync(target.instructionsFile, stripped + '\n', 'utf8');
      }
      touched = true;
    }
  }

  if (existsSync(target.pathInstructionsFile)) {
    rmSync(target.pathInstructionsFile, { force: true });
    touched = true;
  }
  return touched;
}

/** True if the Showtail Copilot instructions are present. */
export function copilotInstalled(target: CopilotTarget): boolean {
  if (existsSync(target.pathInstructionsFile)) return true;
  if (existsSync(target.instructionsFile)) {
    return START_RE.test(readFileSync(target.instructionsFile, 'utf8'));
  }
  return false;
}
