import { connectPlugins } from '../plugins/registry.ts';

export interface ToolStatus {
  /** The tool's CLI name (e.g. 'claude', 'codex'). */
  tool: string;
  /** Human-friendly label (e.g. 'Claude Code'). */
  label: string;
  connected: boolean;
  /** Whether auto-capture hooks are active (tools that install hooks). */
  hooksActive?: boolean;
  /** Whether the managed instructions are behind the latest. */
  updateAvailable?: boolean;
}

/**
 * Connection state of every tool Showtail can integrate with, from the plugin
 * registry. Shared by `status` and `start`. No tool is named here — each
 * connect plugin reports its own state.
 */
export function toolStatuses(cwd?: string): ToolStatus[] {
  return connectPlugins().map((p) => ({
    tool: p.cliName,
    label: p.label,
    ...p.connect.status(cwd),
  }));
}

/** One-line state label for a tool, e.g. `connected · hooks active`. */
export function describeToolState(t: ToolStatus): string {
  if (!t.connected) return 'not connected';
  if (t.hooksActive) return 'connected · hooks active';
  if (t.hooksActive === false) return 'connected · no hooks';
  return 'connected';
}

/** The indented `  claude   <state>` lines printed under a "Connected tools" heading. */
export function connectedToolsLines(tools: ToolStatus[]): string[] {
  return tools.map((t) => `  ${t.tool.padEnd(8)} ${describeToolState(t)}`);
}
