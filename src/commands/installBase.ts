/**
 * Shared output/flow helpers for the hook-based connect commands (Claude Code
 * skill, Codex, Gemini CLI). These tools install instructions + auto-capture
 * hooks at a user or project scope and print the same scaffolding around it; the
 * helpers here keep that scaffolding in one place. Each command still owns its
 * tool-specific steps (e.g. Codex's config.toml prompt) and its own final note.
 */
import type { InstallScope } from '../plugins/types.ts';

export type { InstallScope };

/** Map `--user`/`--project` flags to the install scope (project is the default). */
export function scopeOf(options: { user?: boolean }): InstallScope {
  return options.user ? 'user' : 'project';
}

/**
 * The "Installed/Updated the Showtail <entity>:" header with the written file
 * and scope, followed by a blank line. `entity` is the noun phrase after
 * "the Showtail " (e.g. "skill", "Codex instructions").
 */
export function printInstallHeader(
  entity: string,
  file: string,
  scope: InstallScope,
  existed: boolean,
): void {
  console.log(`${existed ? 'Updated' : 'Installed'} the Showtail ${entity}:`);
  console.log(`  ${file}`);
  console.log(
    `  scope: ${scope === 'user' ? 'personal (all projects)' : 'this project'}`,
  );
  console.log('');
}

/** The "Enabled auto-capture hooks (on by default):" block, with a trailing blank. */
export function printHooksEnabled(hooksFile: string): void {
  console.log('Enabled auto-capture hooks (on by default):');
  console.log(`  ${hooksFile}`);
  console.log('');
}

/**
 * The shared privacy note printed while hooks are active. `editSubject` is the
 * tool name in "snapshots each file <editSubject> edits"; `disconnectName` is
 * the `disconnect <name>` argument. The opt-out stays deliberately unscoped so
 * it establishes the durable machine-wide capture stop; `scope` only supplies
 * the narrower-cleanup hint.
 */
export function printPrivacyNote(opts: {
  editSubject: string;
  disconnectName: string;
  scope: InstallScope;
}): void {
  console.log('  Privacy note: while these hooks are active, Showtail automatically');
  console.log(
    `  logs each prompt you submit and snapshots each file ${opts.editSubject} edits. Capture`,
  );
  console.log('  stays local: resolved work is projected into the project .showtail/;');
  console.log('  unresolved work waits in the local inbox. Nothing leaves your machine.');
  console.log('  Review with `showtail report`. To opt out, re-run with --no-hooks, or');
  console.log(
    `  stop this tool everywhere with \`showtail disconnect ${opts.disconnectName}\`.`,
  );
  console.log(
    `  Use \`--${opts.scope}\` only if you intentionally want a scope-limited removal.`,
  );
}

/**
 * Print the files/components removed by an uninstall. Capture state is reported
 * centrally by `disconnect`, after every scope and native component has been
 * checked; a scope-local helper cannot honestly claim that all capture is off.
 */
export function printUninstallResult(opts: {
  nothingMessage: string;
  removedLines: Array<string | null>;
  trailer?: string;
}): void {
  const lines = opts.removedLines.filter((l): l is string => l !== null);
  if (lines.length === 0) {
    console.log(opts.nothingMessage);
    return;
  }
  for (const line of lines) console.log(line);
  console.log('Done removing the selected Showtail integration.');
  if (opts.trailer) console.log(opts.trailer);
}
