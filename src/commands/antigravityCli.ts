import { existsSync } from 'node:fs';
import {
  antigravityCliAutoCaptureActive,
  installAntigravityCliHooks,
  removeAntigravityCliInstructions,
  resolveAntigravityCliTarget,
  uninstallAntigravityCliHooks,
  writeAntigravityCliInstructions,
} from '../core/antigravityCli.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';
import {
  printHooksEnabled,
  printInstallHeader,
  printPrivacyNote,
  printUninstallResult,
  scopeOf,
} from './installBase.ts';

export interface AntigravityCliInstallOptions {
  user?: boolean;
  project?: boolean;
  /** Install auto-capture hooks. Defaults to true; `--no-hooks` sets false. */
  hooks?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Install (or refresh) the Antigravity CLI instructions and auto-capture hooks. */
export async function runAntigravityCliInstall(
  options: AntigravityCliInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityCliTarget(scope, options.cwd);
  const withHooks = options.hooks !== false; // default ON; --no-hooks opts out

  const existed = existsSync(target.contextFile);
  writeAntigravityCliInstructions(target, { force: options.force });
  printInstallHeader('Antigravity CLI instructions', target.contextFile, scope, existed);

  if (withHooks) {
    installAntigravityCliHooks(target);
    printHooksEnabled(target.hooksFile);
    printPrivacyNote({
      editSubject: 'Antigravity CLI',
      disconnectName: 'antigravity-cli',
      scope,
    });
  } else {
    const removed = uninstallAntigravityCliHooks(target);
    console.log(
      `Auto-capture hooks are OFF at ${scope} scope${removed ? ' (existing Showtail hooks removed)' : ''}.`,
    );
    console.log(
      '  The current managed instructions remain installed, but routine prompts',
    );
    console.log(
      '  and edits will not be captured automatically. Re-run without --no-hooks',
    );
    console.log('  to restore hands-free capture.');
    if (antigravityCliAutoCaptureActive(options.cwd)) {
      console.log('  Automatic capture remains active through the other scope.');
    }
  }

  console.log('');
  console.log(
    'Then just work with Antigravity CLI in this project — it reads the .agents rules automatically.',
  );
}

export interface AntigravityCliUninstallOptions {
  user?: boolean;
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail Antigravity CLI instructions and any hooks we installed. */
export async function runAntigravityCliUninstall(
  options: AntigravityCliUninstallOptions,
): Promise<ConnectUninstallResult> {
  const scopes = options.all
    ? (['project', 'user'] as const)
    : ([scopeOf(options)] as const);
  const removedLines: Array<string | null> = [];

  for (const scope of scopes) {
    const target = resolveAntigravityCliTarget(scope, options.cwd);
    const removedInstructions = removeAntigravityCliInstructions(target);
    const removedHooks = uninstallAntigravityCliHooks(target);
    removedLines.push(
      removedInstructions ? `Removed instructions from: ${target.contextFile}` : null,
      removedHooks ? `Removed Showtail hooks from: ${target.hooksFile}` : null,
    );
  }

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Antigravity CLI integration found in the selected scope(s).',
    removedLines,
  });
  return { captureStopped: !antigravityCliAutoCaptureActive(options.cwd) };
}
