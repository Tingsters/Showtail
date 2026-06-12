import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary.
import COPILOT_INSTRUCTIONS from '../../assets/copilot/copilot-instructions.md' with { type: 'text' };
import SHOWTAIL_PATH_INSTRUCTIONS from '../../assets/copilot/showtail.instructions.md' with { type: 'text' };
import { findRoot } from './storage.ts';

export { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS };

// Markers let us own a section of a possibly user-authored copilot-instructions.md
// without clobbering anything else in it.
const MARKER_START = '<!-- showtail:start -->';
const MARKER_END = '<!-- showtail:end -->';

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

/**
 * The Showtail block, wrapped in markers, for copilot-instructions.md.
 * Ends exactly at the end marker (no trailing newline) so it round-trips
 * cleanly through replaceBetween without growing the file on each refresh.
 */
function showtailBlock(): string {
  return `${MARKER_START}\n${COPILOT_INSTRUCTIONS.trimEnd()}\n${MARKER_END}`;
}

/**
 * Insert or refresh the Showtail section in copilot-instructions.md without
 * disturbing any other content, and write our own path-specific file.
 */
export function writeCopilotInstructions(target: CopilotTarget): void {
  mkdirSync(target.githubDir, { recursive: true });

  const block = showtailBlock();
  let next: string;
  if (existsSync(target.instructionsFile)) {
    const current = readFileSync(target.instructionsFile, 'utf8');
    if (current.includes(MARKER_START) && current.includes(MARKER_END)) {
      next = replaceBetween(current, block);
    } else {
      next = current.trimEnd() + '\n\n' + block + '\n';
    }
  } else {
    next = block + '\n';
  }
  writeIfChanged(target.instructionsFile, next);

  mkdirSync(dirname(target.pathInstructionsFile), { recursive: true });
  writeIfChanged(target.pathInstructionsFile, SHOWTAIL_PATH_INSTRUCTIONS);
}

/**
 * Write only when the content differs — so re-running install to refresh stale
 * instructions is a true no-op when they're already current (no file churn, no
 * editor "changed on disk" noise).
 */
function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  writeFileSync(file, content, 'utf8');
}

/**
 * True when the installed instructions already match the current (embedded)
 * versions — i.e. nothing to refresh.
 */
export function copilotUpToDate(target: CopilotTarget): boolean {
  if (!existsSync(target.pathInstructionsFile)) return false;
  if (readFileSync(target.pathInstructionsFile, 'utf8') !== SHOWTAIL_PATH_INSTRUCTIONS) {
    return false;
  }
  if (!existsSync(target.instructionsFile)) return false;
  return readFileSync(target.instructionsFile, 'utf8').includes(showtailBlock().trim());
}

/** Remove the Showtail section and our path-specific file. */
export function removeCopilotInstructions(target: CopilotTarget): boolean {
  let touched = false;

  if (existsSync(target.instructionsFile)) {
    const current = readFileSync(target.instructionsFile, 'utf8');
    if (current.includes(MARKER_START)) {
      const stripped = replaceBetween(current, '')
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
    return readFileSync(target.instructionsFile, 'utf8').includes(MARKER_START);
  }
  return false;
}

/** Replace the marked region (inclusive) with `replacement`. */
function replaceBetween(content: string, replacement: string): string {
  const start = content.indexOf(MARKER_START);
  const end = content.indexOf(MARKER_END);
  if (start === -1 || end === -1) return content;
  const before = content.slice(0, start);
  const after = content.slice(end + MARKER_END.length);
  return before + replacement + after;
}
