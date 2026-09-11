import { existsSync } from 'node:fs';
import {
  copilotCliAutoCaptureActive,
  copilotCliHooksGloballyDisabled,
  copilotCliHooksInstalledAt,
  copilotCliInstructionsState,
  installCopilotCliHooks,
  removeCopilotCliInstructions,
  resolveCopilotCliTarget,
  uninstallCopilotCliHooks,
  writeCopilotCliInstructions,
} from '../core/copilotCli.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

export interface CopilotCliInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install (or refresh) the GitHub Copilot CLI instructions and auto-capture hooks. */
export async function runCopilotCliInstall(
  options: CopilotCliInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveCopilotCliTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.instructionsFile);
  writeCopilotCliInstructions(target, { force: options.force });
  const instructionState = copilotCliInstructionsState(target);
  printInstallHeader(
    'GitHub Copilot CLI instructions',
    target.instructionsFile,
    scope,
    existed,
  );

  if (withHooks) {
    installCopilotCliHooks(target);
    const globallyDisabled = copilotCliHooksGloballyDisabled();
    if (globallyDisabled) {
      console.log(`Installed Showtail hooks in: ${target.hooksFile}`);
      console.log(
        '  Copilot CLI currently has disableAllHooks enabled, so they are inactive.',
      );
    } else {
      printHooksEnabled(target.hooksFile);
      printPrivacyNote({
        editSubject: 'GitHub Copilot CLI',
        disconnectName: 'copilot-cli',
        scope,
      });
    }
  } else {
    const removed = uninstallCopilotCliHooks(target);
    console.log(
      `Auto-capture hooks are OFF at ${scope} scope${removed ? ' (existing Showtail hooks removed)' : ''}.`,
    );
    const otherScope = scope === 'user' ? 'project' : 'user';
    const other = resolveCopilotCliTarget(otherScope, options.cwd);
    if (copilotCliHooksGloballyDisabled()) {
      console.log(
        '  Copilot CLI has disableAllHooks enabled, so no hook scope is active.',
      );
    } else if (copilotCliHooksInstalledAt(other.hooksFile)) {
      console.log(
        `  Automatic capture remains active through ${otherScope}-scope hooks.`,
      );
    } else {
      console.log(
        '  Automatic Copilot CLI capture is off. Re-run without --no-hooks to enable it.',
      );
    }
  }

  if (instructionState.userEdited && instructionState.updateAvailable && !options.force) {
    console.log('');
    console.log('A newer safety update is available for your customized instructions.');
    console.log(
      'Your edits were kept; use `--force` once to take the latest managed block.',
    );
  }

  console.log('');
  console.log(
    'Then just work with GitHub Copilot CLI in this project — it reads the instructions automatically.',
  );
}

export interface CopilotCliUninstallOptions {
  user?: boolean;
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail GitHub Copilot CLI instructions and any hooks we installed. */
export async function runCopilotCliUninstall(
  options: CopilotCliUninstallOptions,
): Promise<ConnectUninstallResult> {
  const scopes = options.all
    ? (['project', 'user'] as const)
    : ([scopeOf(options)] as const);
  const removedLines: Array<string | null> = [];

  for (const scope of scopes) {
    const target = resolveCopilotCliTarget(scope, options.cwd);
    const removedInstructions = removeCopilotCliInstructions(target);
    const removedHooks = uninstallCopilotCliHooks(target);
    removedLines.push(
      removedInstructions
        ? `Removed instructions from: ${target.instructionsFile}`
        : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    );
  }

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail GitHub Copilot CLI integration found in the selected scope(s).',
    removedLines,
  });
  return { captureStopped: !copilotCliAutoCaptureActive(options.cwd) };
}
