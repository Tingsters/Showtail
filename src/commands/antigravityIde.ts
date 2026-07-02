import { existsSync } from 'node:fs';
import {
  removeAntigravityIdeInstructions,
  resolveAntigravityIdeTarget,
  uninstallAntigravityIdeHooks,
  writeAntigravityIdeInstructions,
} from '../core/antigravityIde.ts';
import {
  ANTIGRAVITY_EXTENSION_ID,
  installAntigravityIdeExtension,
} from '../core/antigravityIdeExtension.ts';
import { printInstallHeader, printUninstallResult, scopeOf } from './installBase.ts';

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
  console.log(
    'Privacy: Showtail records your prompts and snapshots edits into your local',
  );
  console.log('  .showtail/ folder — nothing leaves your machine. Review with `showtail');
  console.log('  report`; stop anytime with `showtail disconnect antigravity-ide`.');
  console.log('');
  console.log('Then just work in Antigravity IDE — your prompts and edits are captured.');
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
