import { existsSync } from 'node:fs';
import {
  installHooks,
  removeSkill,
  resolveTarget,
  uninstallHooks,
  writeSkill,
} from '../core/skill.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

export interface SkillInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install the Showtail skill and, by default, the auto-capture hooks. */
export async function runSkillInstall(options: SkillInstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.skillFile);
  writeSkill(target);
  printInstallHeader('skill', target.skillFile, scope, existed);

  if (withHooks) {
    installHooks(target);
    printHooksEnabled(target.settingsFile);
    printPrivacyNote({ editSubject: 'Claude', disconnectName: 'claude', scope });
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log('  The skill will instead log prompts and snapshot edits itself as you');
    console.log('  pair with Claude. That capture is model-driven, so it may be less');
    console.log('  complete than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log('Open Claude Code in this project and the skill will be available');
  console.log('automatically (or invoke it explicitly with `/showtail`).');
}

export interface SkillUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail skill and any hooks we installed. */
export async function runSkillUninstall(options: SkillUninstallOptions): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveTarget(scope, options.cwd);

  const removedSkill = removeSkill(target);
  const touchedSettings = uninstallHooks(target);

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail skill or hooks found for this scope.',
    removedLines: [
      removedSkill ? `Removed skill: ${target.skillDir}` : null,
      touchedSettings ? `Removed Showtail hooks from: ${target.settingsFile}` : null,
    ],
  });
}
