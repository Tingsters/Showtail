import { join } from 'node:path';
import {
  removeReportSkill,
  REPORT_SKILL,
  reportSkillState,
  retireInstructions,
  writeReportSkill,
} from './reportDiscovery.ts';
import { findRoot } from './storage.ts';
export const COPILOT_INSTRUCTIONS = REPORT_SKILL;
export const SHOWTAIL_PATH_INSTRUCTIONS = REPORT_SKILL;
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
  force?: boolean;
}
export function writeCopilotInstructions(
  target: CopilotTarget,
  options: WriteOptions = {},
): void {
  writeReportSkill(
    'copilot',
    [target.instructionsFile, target.pathInstructionsFile],
    options.force,
  );
}
export function copilotState(_target: CopilotTarget) {
  return reportSkillState('copilot');
}
export function copilotUpToDate(target: CopilotTarget): boolean {
  return copilotState(target).upToDate;
}
export function copilotInstalled(target: CopilotTarget): boolean {
  return copilotState(target).installed;
}
export function removeCopilotInstructions(target: CopilotTarget): boolean {
  const retired = [target.instructionsFile, target.pathInstructionsFile]
    .map(retireInstructions)
    .some(Boolean);
  return removeReportSkill('copilot') || retired;
}
