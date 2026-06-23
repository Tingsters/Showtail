import { existsSync } from 'node:fs';
import {
  installAntigravityIdeHooks,
  removeAntigravityIdeInstructions,
  resolveAntigravityIdeTarget,
  uninstallAntigravityIdeHooks,
  writeAntigravityIdeInstructions,
} from '../core/antigravityIde.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

export interface AntigravityIdeInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install (or refresh) the Antigravity IDE instructions and auto-capture hooks. */
export async function runAntigravityIdeInstall(
  options: AntigravityIdeInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityIdeTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.contextFile);
  writeAntigravityIdeInstructions(target, { force: options.force });
  printInstallHeader('Antigravity IDE instructions', target.contextFile, scope, existed);

  if (withHooks) {
    installAntigravityIdeHooks(target);
    printHooksEnabled(target.hooksFile);
    // The IDE loads ONE global hooks file (no per-workspace path), and only at
    // language-server startup — so connecting always writes the global file and
    // the user must restart the IDE for it to take effect.
    console.log('  Note: the Antigravity IDE reads this one global hooks file for every');
    console.log(
      '  workspace, and only at startup — so RESTART the IDE to start capturing.',
    );
    console.log('');
    printPrivacyNote({
      editSubject: 'Antigravity IDE',
      disconnectName: 'antigravity-ide',
      scope,
    });
  } else {
    console.log('Auto-capture hooks were SKIPPED (--no-hooks).');
    console.log(
      '  The instructions still teach Antigravity IDE to log prompts and snapshot',
    );
    console.log(
      '  edits itself as you pair. That capture is model-driven, so it may be less',
    );
    console.log('  complete than the hooks. Re-run without --no-hooks to enable them.');
  }

  console.log('');
  console.log(
    'Then just work in Antigravity IDE — it reads the rules file automatically.',
  );
}

export interface AntigravityIdeUninstallOptions {
  user?: boolean;
  cwd?: string;
}

/** Remove the Showtail Antigravity IDE instructions and any hooks we installed. */
export async function runAntigravityIdeUninstall(
  options: AntigravityIdeUninstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityIdeTarget(scope, options.cwd);

  const removedInstructions = removeAntigravityIdeInstructions(target);
  const removedHooks = uninstallAntigravityIdeHooks(target);

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Antigravity IDE integration found for this scope.',
    removedLines: [
      removedInstructions ? `Removed instructions from: ${target.contextFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    ],
  });
}
