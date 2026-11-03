/** Reporting is discoverable on request; collection never depends on instructions. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import SKILL from '../../assets/shared/report-skill.md' with { type: 'text' };
import SUBMISSION from '../../assets/shared/submission.md' with { type: 'text' };
import { dataPath } from './dataHome.ts';
import { readGlobalConfig, writeGlobalConfig } from './globalConfig.ts';
import { sha256OfString as digest } from './hash.ts';
import { hostHome } from './hostHome.ts';
import {
  applyManagedBlock,
  classify,
  parseBlock,
  shortHash,
  splitFrontmatter,
} from './managedBlock.ts';

export const REPORT_SKILL = SKILL;
export function reportSkillFile(tool: string): string {
  const base =
    tool === 'claude' || tool === 'claude-code'
      ? hostHome('CLAUDE_CONFIG_DIR', '.claude')
      : tool === 'codex'
        ? hostHome('CODEX_HOME', '.codex')
        : tool.startsWith('antigravity')
          ? join(hostHome('GEMINI_HOME', '.gemini'), 'config')
          : hostHome('COPILOT_HOME', '.copilot');
  return join(base, 'skills', 'showtail', 'SKILL.md');
}
const assistantKey = (tool: string) =>
  tool.startsWith('antigravity')
    ? 'antigravity'
    : tool === 'copilot-cli'
      ? 'copilot'
      : tool === 'claude-code'
        ? 'claude'
        : tool;
export function setReportDiscovery(tool: string, enabled: boolean): void {
  tool = assistantKey(tool);
  const cfg = readGlobalConfig();
  const disabled = new Set(cfg.assistantDisabledTools ?? []);
  enabled ? disabled.delete(tool) : disabled.add(tool);
  writeGlobalConfig({ ...cfg, assistantDisabledTools: [...disabled] });
}

/** Back up owned blocks before retiring them; leave all surrounding bytes intact. */
export function retireInstructions(file: string): boolean {
  if (!existsSync(file)) return false;
  const current = readFileSync(file, 'utf8');
  const parsed = parseBlock(current);
  if (!parsed) return false;
  backupIntegrationFile(file);
  const rest = current.slice(0, parsed.startIndex) + current.slice(parsed.endIndex);
  const { body } = splitFrontmatter(rest.replace(/\r\n/g, '\n'));
  if (!body.trim()) unlinkSync(file);
  else writeFileSync(file, rest);
  return true;
}
export function backupIntegrationFile(file: string): void {
  if (!existsSync(file)) return;
  const backup = dataPath('maintenance', 'passive-capture', `${digest(file)}.json`);
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  if (!existsSync(backup))
    writeFileSync(backup, JSON.stringify({ file, content: readFileSync(file, 'utf8') }), {
      mode: 0o600,
    });
}
export function writeReportSkill(
  tool: string,
  legacy: string[] = [],
  force = false,
): string {
  for (const file of legacy) retireInstructions(file);
  const file = reportSkillFile(tool);
  if (readGlobalConfig().assistantDisabledTools?.includes(assistantKey(tool))) {
    removeReportSkill(tool);
    return file;
  }
  mkdirSync(dirname(file), { recursive: true });
  const { preamble, body } = splitFrontmatter(SKILL);
  // The old Claude skill may grant tools through its frontmatter. Replace owned
  // skills as a whole after backing them up; never keep those permission grants.
  if (existsSync(file) && parseBlock(readFileSync(file, 'utf8'))) {
    const current = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (!current.startsWith(preamble)) retireInstructions(file);
  }
  applyManagedBlock(file, body, preamble, force);
  const reference = join(dirname(file), 'submission.md');
  if (!existsSync(reference)) writeFileSync(reference, '', { mode: 0o600 });
  applyManagedBlock(reference, SUBMISSION, '', force);
  return file;
}
export function reportSkillState(tool: string) {
  const file = reportSkillFile(tool);
  const parsed = existsSync(file) ? parseBlock(readFileSync(file, 'utf8')) : null;
  const cls = parsed ? classify(parsed, splitFrontmatter(SKILL).body) : undefined;
  return {
    installed: !!parsed,
    requiresReview: existsSync(file) && !parsed,
    upToDate: cls === 'uptodate',
    userEdited: cls === 'edited',
    updateAvailable:
      !!parsed &&
      cls !== 'uptodate' &&
      parsed.sha !== shortHash(splitFrontmatter(SKILL).body),
  };
}
export function removeReportSkill(tool: string): boolean {
  const file = reportSkillFile(tool);
  const removed = retireInstructions(file);
  if (!existsSync(file)) {
    const reference = join(dirname(file), 'submission.md');
    if (
      existsSync(reference) &&
      readFileSync(reference, 'utf8').replace(/\r\n/g, '\n') === SUBMISSION
    ) {
      backupIntegrationFile(reference);
      unlinkSync(reference);
    } else retireInstructions(reference);
    try {
      rmdirSync(dirname(file));
    } catch {
      /* Preserve other user files. */
    }
  }
  return removed;
}
