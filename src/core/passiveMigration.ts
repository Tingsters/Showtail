/** Upgrade only known Showtail installations; never search arbitrary projects. */
import { writeJson } from './storage.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveAntigravityCliTarget,
  uninstallAntigravityCliHooks,
} from './antigravityCli.ts';
import {
  resolveAntigravityIdeTarget,
  uninstallAntigravityIdeHooks,
} from './antigravityIde.ts';
import { resolveCodexTarget, uninstallCodexHooks } from './codex.ts';
import { resolveCopilotCliTarget, uninstallCopilotCliHooks } from './copilotCli.ts';
import { HistoryStore, historyExists } from './history.ts';
import { hostHome } from './hostHome.ts';
import { parseBlock, splitFrontmatter } from './managedBlock.ts';
import {
  REPORT_SKILL,
  backupIntegrationFile,
  reportSkillFile,
  retireInstructions,
  writeReportSkill,
} from './reportDiscovery.ts';
import { resolveTarget, uninstallHooks } from './skill.ts';

export function migratePassiveIntegration(tool?: string): {
  retired: number;
  restartRequired: boolean;
  warnings: { file: string; code: string }[];
} {
  let retired = 0;
  const warnings: { file: string; code: string }[] = [];
  const selected = (name: string) => !tool || name === tool;
  const clean = (files: (string | undefined)[]) => {
    for (const file of files)
      if (file) {
        if (retireInstructions(file)) retired++;
        else if (
          existsSync(file) &&
          /Showtail: help the student|showtail (?:status|log|artifact)/i.test(
            readFileSync(file, 'utf8'),
          )
        )
          warnings.push({ file, code: 'UNMARKED_INSTRUCTIONS_REQUIRE_REVIEW' });
      }
  };
  const remove = (file: string, fn: () => unknown) => {
    if (!existsSync(file)) return;
    backupIntegrationFile(file);
    try {
      fn();
    } catch {
      warnings.push({ file, code: 'HOOK_CONFIG_REQUIRES_REVIEW' });
    }
  };
  const retireClaudePlugin = (settingsFile: string, claudeDir: string) => {
    // Cached plugins load skills independently of the user skill. Replace only
    // a registration whose installed manifest proves this repository owns it.
    if (existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
        if (settings.enabledPlugins?.['showtail@showtail'] === true) {
          const registry = JSON.parse(
            readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'),
          );
          const entries = registry.plugins?.['showtail@showtail'];
          const owned =
            Array.isArray(entries) &&
            entries.some((entry) => {
              try {
                const manifest = JSON.parse(
                  readFileSync(
                    join(entry.installPath, '.claude-plugin', 'plugin.json'),
                    'utf8',
                  ),
                );
                return (
                  manifest.name === 'showtail' &&
                  manifest.repository?.replace(/\.git$/, '').replace(/\/$/, '') ===
                    'https://github.com/Tingsters/Showtail'
                );
              } catch {
                return false;
              }
            });
          if (owned) {
            settings.enabledPlugins['showtail@showtail'] = false;
            backupIntegrationFile(settingsFile);
            writeJson(settingsFile, settings);
            writeReportSkill('claude');
            retired++;
          } else
            warnings.push({
              file: settingsFile,
              code: 'CLAUDE_PLUGIN_REQUIRES_REVIEW',
            });
        }
      } catch {
        warnings.push({
          file: settingsFile,
          code: 'CLAUDE_PLUGIN_REQUIRES_REVIEW',
        });
      }
    }
  };
  if (selected('codex')) {
    const t = resolveCodexTarget('user');
    clean([t.agentsFile, t.legacyAgentsFile]);
    backupIntegrationFile(t.hooksFile);
    backupIntegrationFile(t.configToml);
  }
  if (selected('claude')) {
    const target = resolveTarget('user');
    backupIntegrationFile(target.settingsFile);
    retireClaudePlugin(target.settingsFile, target.claudeDir);
    const skill = reportSkillFile('claude');
    if (existsSync(skill)) {
      const content = readFileSync(skill, 'utf8').replace(/\r\n/g, '\n');
      if (
        parseBlock(content) &&
        !content.startsWith(splitFrontmatter(REPORT_SKILL).preamble)
      ) {
        writeReportSkill('claude');
        retired++;
      }
    }
  }
  if (selected('copilot-cli')) clean([resolveCopilotCliTarget('user').instructionsFile]);
  if (selected('antigravity-cli'))
    clean([resolveAntigravityCliTarget('user').contextFile]);
  if (selected('antigravity-ide')) {
    clean([resolveAntigravityIdeTarget('user').contextFile]);
    const t = resolveAntigravityIdeTarget('user');
    remove(t.hooksFile, () => uninstallAntigravityIdeHooks(t));
  }
  if (selected('copilot-cli'))
    backupIntegrationFile(resolveCopilotCliTarget('user').hooksFile);
  if (selected('antigravity-cli'))
    backupIntegrationFile(resolveAntigravityCliTarget('user').hooksFile);
  // Old global Copilot instructions are distinct from report skills.
  if (selected('copilot'))
    clean([
      join(
        hostHome('COPILOT_HOME', '.copilot'),
        'instructions',
        'showtail.instructions.md',
      ),
    ]);
  if (historyExists()) {
    using store = new HistoryStore({ readonly: true });
    const roots = new Set(
      store
        .projects()
        .map((p) => p.projectRoot)
        .filter((p): p is string => !!p),
    );
    for (const root of roots) {
      if (selected('codex')) {
        clean([join(root, 'AGENTS.md')]);
        const t = {
          ...resolveCodexTarget('user'),
          hooksFile: join(root, '.codex', 'hooks.json'),
        };
        remove(t.hooksFile, () => uninstallCodexHooks(t));
      }
      if (selected('claude')) {
        clean([join(root, '.claude', 'skills', 'showtail', 'SKILL.md')]);
        const t = {
          ...resolveTarget('user'),
          settingsFile: join(root, '.claude', 'settings.json'),
        };
        remove(t.settingsFile, () => uninstallHooks(t));
        retireClaudePlugin(t.settingsFile, t.claudeDir);
        const local = {
          ...t,
          settingsFile: join(root, '.claude', 'settings.local.json'),
        };
        remove(local.settingsFile, () => uninstallHooks(local));
        retireClaudePlugin(local.settingsFile, t.claudeDir);
      }
      if (selected('copilot'))
        clean([
          join(root, '.github', 'copilot-instructions.md'),
          join(root, '.github', 'instructions', 'showtail.instructions.md'),
        ]);
      if (selected('copilot-cli')) {
        clean([
          join(root, '.github', 'instructions', 'showtail-copilot-cli.instructions.md'),
        ]);
        const t = {
          ...resolveCopilotCliTarget('user'),
          hooksFile: join(root, '.github', 'hooks', 'showtail.json'),
        };
        remove(t.hooksFile, () => uninstallCopilotCliHooks(t));
      }
      if (selected('antigravity-cli')) {
        clean([join(root, '.agents', 'AGY.showtail.md')]);
        const t = {
          ...resolveAntigravityCliTarget('user'),
          hooksFile: join(root, '.agents', 'hooks.json'),
        };
        remove(t.hooksFile, () => uninstallAntigravityCliHooks(t));
      }
      if (selected('antigravity-ide'))
        clean([join(root, '.agents', 'AGY-IDE.showtail.md')]);
    }
  }
  return { retired, restartRequired: retired > 0, warnings };
}
