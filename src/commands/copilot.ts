import {
  installVsCodeExtension,
  uninstallVsCodeExtension,
} from '../core/vscodeExtension.ts';
import type { ConnectUninstallResult } from '../plugins/types.ts';

export interface CopilotInstallOptions {
  extension?: boolean;
  force?: boolean;
  cwd?: string;
}

/** Copilot capture is supplied by the user-level extension; no repo instructions. */
export async function runCopilotInstall(options: CopilotInstallOptions): Promise<void> {
  if (options.extension === false) {
    console.log(
      'Project instructions are no longer needed. Install the Showtail VS Code extension to enable capture.',
    );
    return;
  }
  const result = installVsCodeExtension();
  console.log(
    result.installed
      ? 'Installed the Showtail VS Code extension for this user.'
      : 'Install the Showtail extension with: code --install-extension Tingsters.showtail',
  );
}

export interface CopilotUninstallOptions {
  all?: boolean;
  cwd?: string;
}
export async function runCopilotUninstall(
  _options: CopilotUninstallOptions = {},
): Promise<ConnectUninstallResult> {
  const result = uninstallVsCodeExtension();
  console.log(
    result.uninstalled
      ? 'Removed the Showtail VS Code extension. Reload open editor windows.'
      : 'Capture is disabled. Remove Tingsters.showtail in VS Code and reload the window.',
  );
  return {
    captureStopped: result.uninstalled,
    ...(result.uninstalled
      ? {}
      : {
          warnings: [
            'The extension could not be removed; capture remains disabled by the user-level consent setting.',
          ],
        }),
  };
}
