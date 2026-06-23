import { existsSync } from 'node:fs';
import {
  installCopilotCliHooks,
  removeCopilotCliInstructions,
  resolveCopilotCliTarget,
  uninstallCopilotCliHooks,
  writeCopilotCliInstructions,
} from '../core/copilotCli.ts';
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
  printInstallHeader(
    'GitHub Copilot CLI instructions',
    target.instructionsFile,
    scope,
    existed,
  );

  if (withHooks) {
    installCopilotCliHooks(target);
    printHooksEnabled(target.hooksFile);
    printPrivacyNote({
      editSubject: 'GitHub Copilot CLI',
      disconnectName: 'copilot-cli',
      scope,
    });
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log(
      '  The instructions still teach Copilot CLI to log prompts and snapshot edits',
    );
    console.log(
      '  itself as you pair. That capture is model-driven, so it may be less complete',
    );
    console.log('  than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log(
    'Then just work with GitHub Copilot CLI in this project — it reads the instructions automatically.',
  );
}

export interface CopilotCliUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail GitHub Copilot CLI instructions and any hooks we installed. */
export async function runCopilotCliUninstall(
  options: CopilotCliUninstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveCopilotCliTarget(scope, options.cwd);

  const removedInstructions = removeCopilotCliInstructions(target);
  const removedHooks = uninstallCopilotCliHooks(target);

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail GitHub Copilot CLI integration found for this scope.',
    removedLines: [
      removedInstructions
        ? `Removed instructions from: ${target.instructionsFile}`
        : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    ],
  });
}
