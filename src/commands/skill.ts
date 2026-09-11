import { existsSync } from 'node:fs';
import {
  autoCaptureActive,
  installHooks,
  removeSkill,
  resolveTarget,
  uninstallHooks,
  writeSkill,
} from '../core/skill.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';
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
    const removed = uninstallHooks(target);
    console.log(
      `Auto-capture hooks are OFF at ${scope} scope${removed ? ' (existing Showtail hooks removed)' : ''}.`,
    );
    console.log('  The current managed skill remains installed, but routine prompts');
    console.log(
      '  and edits will not be captured automatically. Re-run without --no-hooks',
    );
    console.log('  to restore hands-free capture.');
    if (autoCaptureActive(options.cwd)) {
      console.log('  Automatic capture remains active through the other scope.');
    }
  }

  console.log('');
  console.log('Open Claude Code in this project and the skill will be available');
  console.log('automatically (or invoke it explicitly with `/showtail`).');
}

export interface SkillUninstallOptions {
  user?: boolean;
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail skill and any hooks we installed. */
export async function runSkillUninstall(
  options: SkillUninstallOptions,
): Promise<ConnectUninstallResult> {
  const scopes = options.all
    ? (['project', 'user'] as const)
    : ([scopeOf(options)] as const);
  const removedLines: Array<string | null> = [];

  for (const scope of scopes) {
    const target = resolveTarget(scope, options.cwd);
    const removedSkill = removeSkill(target);
    const touchedSettings = uninstallHooks(target);
    removedLines.push(
      removedSkill ? `Removed skill: ${target.skillDir}` : null,
      touchedSettings ? `Removed Showtail hooks from: ${target.settingsFile}` : null,
    );
  }

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail skill or hooks found in the selected scope(s).',
    removedLines,
  });
  return { captureStopped: !autoCaptureActive(options.cwd) };
}
