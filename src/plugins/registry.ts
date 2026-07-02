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
import { antigravityIdePlugin } from './antigravity-ide.ts';
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
  antigravityIdePlugin,
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

/** Capitalize the first letter, lower-case the rest (for a model variant word). */
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s;
}

/**
 * Human label for a raw model id, so reports read naturally across every tool:
 * `claude-opus-4-8` → "Opus 4.8", `gpt-5.3-codex` → "GPT-5.3 Codex", `gpt-5.5` →
 * "GPT-5.5", `gemini-2.5-pro` → "Gemini 2.5 Pro", and the human-readable names
 * Gemini share ("3.5 Flash") and Antigravity ("Gemini 3.5 Flash (Medium)") emit
 * → "Gemini 3.5 Flash". Any context-window suffix (`[1m]`, `[200k]`) is stripped.
 * Falls back to the raw string so an unknown or brand-new id still renders and
 * never throws.
 */
export function labelForModel(model: string): string {
  const raw = model.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  if (!raw) return model.trim();

  // Anthropic: claude-<family>-<maj>-<min>[-…] → "Opus 4.8"
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)\b/i.exec(raw);
  if (claude) return `${cap(claude[1]!)} ${claude[2]}.${claude[3]}`;

  // OpenAI GPT: gpt-<ver>[-codex] → "GPT-5.3 Codex" / "GPT-5.5"
  const gpt = /^gpt-([\d.]+)(?:-(codex))?/i.exec(raw);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' Codex' : ''}`;

  // OpenAI o-series: o3, o1-mini (a digit must follow "o", so "opus" won't match).
  if (/^o\d+(?:-\w+)?$/i.test(raw)) return raw.toLowerCase();

  // Gemini slug: gemini-<ver>-<variant> → "Gemini 2.5 Pro"
  const gemSlug = /^gemini-([\d.]+)-(pro|flash|ultra|nano)\b/i.exec(raw);
  if (gemSlug) return `Gemini ${gemSlug[1]} ${cap(gemSlug[2]!)}`;

  // Human-readable Gemini names: "3.5 Flash" / "Gemini 3.5 Flash (Medium)".
  const gemHuman = /^(?:gemini\s+)?(\d+\.\d+)\s+(pro|flash|ultra|nano)\b/i.exec(raw);
  if (gemHuman) return `Gemini ${gemHuman[1]} ${cap(gemHuman[2]!)}`;

  return raw;
}
