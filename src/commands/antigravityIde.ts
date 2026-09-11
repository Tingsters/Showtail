import { existsSync } from 'node:fs';
import {
  antigravityIdeAutoCaptureActive,
  removeAntigravityIdeInstructions,
  resolveAntigravityIdeTarget,
  uninstallAntigravityIdeHooks,
  writeAntigravityIdeInstructions,
} from '../core/antigravityIde.ts';
import {
  ANTIGRAVITY_EXTENSION_ID,
  installAntigravityIdeExtension,
  uninstallAntigravityIdeExtension,
} from '../core/antigravityIdeExtension.ts';
import { printInstallHeader, printUninstallResult, scopeOf } from './installBase.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';

export interface AntigravityIdeInstallOptions {
  user?: boolean;
  project?: boolean;
  force?: boolean;
  cwd?: string;
}

/**
 * Install (or refresh) the Antigravity IDE integration: the rules file plus the
 * Showtail VS Code extension — the reliable capture path (it watches the IDE's
 * transcript and imports it). We deliberately do NOT write the IDE's lifecycle
 * `hooks.json`: that build only ever fires `PostToolUse` (no `Stop`/`PreInvocation`,
 * no stable session id), so the hooks can't capture the conversation. The
 * extension supersedes them. (`disconnect` still cleans up any hooks an older
 * version left behind.)
 */
export async function runAntigravityIdeInstall(
  options: AntigravityIdeInstallOptions,
): Promise<void> {
  const scope = scopeOf(options);
  const target = resolveAntigravityIdeTarget(scope, options.cwd);

  const existed = existsSync(target.contextFile);
  writeAntigravityIdeInstructions(target, { force: options.force });
  printInstallHeader('Antigravity IDE instructions', target.contextFile, scope, existed);

  // The capture path: the Showtail VS Code extension, installed via the IDE's CLI.
  const ext = installAntigravityIdeExtension();
  if (ext.installed) {
    console.log(`Installed the Showtail extension into Antigravity IDE (${ext.vsix}).`);
    console.log('  RESTART the IDE once so it loads — then capture is automatic.');
  } else if (ext.reason === 'cli-not-found') {
    console.log('Could not find the Antigravity IDE CLI to install the extension.');
    console.log(`  Install it from your IDE: search "${ANTIGRAVITY_EXTENSION_ID}" in`);
    console.log(
      '  Extensions, or run: antigravity-ide --install-extension <showtail.vsix>',
    );
  } else if (ext.reason === 'vsix-not-bundled') {
    console.log('The Showtail extension VSIX was not bundled with this build.');
    console.log(
      `  Install it manually: antigravity-ide --install-extension ${ANTIGRAVITY_EXTENSION_ID}`,
    );
  } else {
    console.log(`Could not install the Showtail extension: ${ext.reason}`);
    console.log(
      '  Try manually: antigravity-ide --install-extension <showtail.vsix> --force',
    );
  }

  console.log('');
  if (ext.installed) {
    console.log(
      'Privacy: Showtail records your prompts and snapshots edits into your local',
    );
    console.log(
      '  .showtail/ folder — nothing leaves your machine. Review with `showtail',
    );
    console.log('  report`; stop anytime with `showtail disconnect antigravity-ide`.');
    console.log('');
    console.log(
      'Then just work in Antigravity IDE — your prompts and edits are captured.',
    );
  } else {
    console.log(
      'The instructions are installed, but automatic capture is not active yet.',
    );
    console.log(
      'Install the extension and restart Antigravity IDE before you begin working.',
    );
    console.log(
      'Once enabled, capture stays local and resolves into project .showtail/ trails.',
    );
  }
}

export interface AntigravityIdeUninstallOptions {
  user?: boolean;
  all?: boolean;
  cwd?: string;
}

/** Remove the Showtail Antigravity IDE instructions and any hooks we installed. */
export async function runAntigravityIdeUninstall(
  options: AntigravityIdeUninstallOptions,
): Promise<ConnectUninstallResult> {
  const scopes = options.all
    ? (['project', 'user'] as const)
    : ([scopeOf(options)] as const);
  const removedLines: Array<string | null> = [];

  for (const scope of scopes) {
    const target = resolveAntigravityIdeTarget(scope, options.cwd);
    const removedInstructions = removeAntigravityIdeInstructions(target);
    const removedHooks = uninstallAntigravityIdeHooks(target);
    removedLines.push(
      removedInstructions ? `Removed instructions from: ${target.contextFile}` : null,
      removedHooks ? `Removed legacy Showtail hooks from: ${target.hooksFile}` : null,
    );
  }

  const removeNativeCapture = options.all || scopes.includes('user');
  const extension = removeNativeCapture ? uninstallAntigravityIdeExtension() : undefined;
  if (extension?.wasInstalled) {
    removedLines.push(
      `Removed the Showtail extension from Antigravity IDE (${ANTIGRAVITY_EXTENSION_ID}).`,
      'Reload any open Antigravity IDE windows to unload the running extension.',
    );
  }

  printUninstallResult({
    nothingMessage:
      'Nothing to remove — no Showtail Antigravity IDE integration found in the selected scope(s).',
    removedLines,
  });

  const warnings: string[] = [];
  if (extension && !extension.uninstalled) {
    warnings.push(
      `Could not remove or verify the Antigravity IDE extension (${extension.reason ?? 'unknown error'}). ` +
        `Remove ${ANTIGRAVITY_EXTENSION_ID} in the IDE, then reload open Antigravity IDE windows.`,
    );
  } else if (!removeNativeCapture) {
    warnings.push(
      'Only the project integration was removed; the user-wide Antigravity IDE extension was left in place. ' +
        'Run `showtail disconnect antigravity-ide` without a scope flag to stop it.',
    );
  }
  const extensionStopped = removeNativeCapture ? extension?.uninstalled === true : false;
  return {
    captureStopped: !antigravityIdeAutoCaptureActive(options.cwd) && extensionStopped,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
