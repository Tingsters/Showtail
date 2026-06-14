import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Single source of truth: committed under assets/ AND embedded into the binary.
import COPILOT_INSTRUCTIONS from '../../assets/copilot/copilot-instructions.md' with { type: 'text' };
import SHOWTAIL_PATH_INSTRUCTIONS from '../../assets/copilot/showtail.instructions.md' with { type: 'text' };
import {
  applyManagedBlock,
  classify,
  parseBlock,
  shortHash,
  splitFrontmatter,
  START_RE,
} from './managedBlock.ts';
import { findRoot } from './storage.ts';

export { COPILOT_INSTRUCTIONS, SHOWTAIL_PATH_INSTRUCTIONS };

// Copilot requires frontmatter at the very top of the path-specific file, so it
// sits OUTSIDE the managed block as a small preamble; the body is what Showtail
// manages/fingerprints.
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
