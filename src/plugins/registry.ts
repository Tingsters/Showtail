/**
 * The registry of AI coding-environment plugins.
 *
 * This is the single place that knows the set of integrations. Everything else
 * (cli dispatch, status, setup/detection, report labels) goes through the
 * lookups here, so no other module hard-codes a tool name. Adding an
 * environment = add its module to {@link PLUGINS}.
 */
import type { Tool } from '../types.ts';
import type { ConnectCapability, EnvironmentPlugin, ImportCapability } from './types.ts';
import { claudeCodePlugin } from './claude-code.ts';
import { copilotPlugin } from './copilot.ts';
import { copilotCliPlugin } from './copilot-cli.ts';
import { codexPlugin } from './codex.ts';
import { geminiCliPlugin } from './gemini-cli.ts';
import { antigravityCliPlugin } from './antigravity-cli.ts';
import { chatgptPlugin } from './chatgpt.ts';
import { geminiPlugin } from './gemini.ts';

/** Every environment Showtail integrates with. Order is the display order. */
export const PLUGINS: EnvironmentPlugin[] = [
  claudeCodePlugin,
  copilotPlugin,
  copilotCliPlugin,
  codexPlugin,
  geminiCliPlugin,
  antigravityCliPlugin,
  chatgptPlugin,
  geminiPlugin,
];

/** A plugin guaranteed to expose a connect capability. */
export type ConnectPlugin = EnvironmentPlugin & { connect: ConnectCapability };
/** A plugin guaranteed to expose an import capability. */
export type ImportPlugin = EnvironmentPlugin & { import: ImportCapability };

/** Look a plugin up by its cliName, id, or any alias (case-insensitive). */
export function getPlugin(raw: string): EnvironmentPlugin | undefined {
  const key = raw.toLowerCase();
  return PLUGINS.find(
    (p) =>
      p.cliName.toLowerCase() === key ||
      p.id.toLowerCase() === key ||
      p.aliases.some((a) => a.toLowerCase() === key),
  );
}

/** Plugin by its canonical tool id (used when a hook fires with `--tool <id>`). */
export function getPluginById(id: Tool): EnvironmentPlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

/** All plugins that can be connected for live capture, in display order. */
export function connectPlugins(): ConnectPlugin[] {
  return PLUGINS.filter((p): p is ConnectPlugin => Boolean(p.connect));
}

/** All plugins that can import a transcript, in display order. */
export function importPlugins(): ImportPlugin[] {
  return PLUGINS.filter((p): p is ImportPlugin => Boolean(p.import));
}

/**
 * Resolve a connect plugin by name for `connect`/`disconnect`, with a friendly
 * error listing the valid names when the tool is unknown or has no connect
 * capability.
 */
export function connectPluginOrThrow(raw: string): ConnectPlugin {
  const plugin = getPlugin(raw);
  const names = connectPlugins()
    .map((p) => p.cliName)
    .join(', ');
  if (!plugin || !plugin.connect) {
    throw new Error(`Unknown tool "${raw}". Choose one of: ${names}.`);
  }
  return plugin as ConnectPlugin;
}

/** Human label for a tool id, from the registry. Falls back to the raw value. */
export function labelForTool(tool: string): string {
  if (tool === 'cli') return 'CLI';
  return getPluginById(tool as Tool)?.label ?? tool;
}
