/**
 * The plugin model for AI coding environments.
 *
 * Every individual coding system Showtail integrates with (Claude Code, Codex,
 * Copilot, ChatGPT, Gemini, the Gemini CLI, …) is described by one
 * {@link EnvironmentPlugin}. The rest of Showtail — the CLI dispatch, status,
 * setup/detection, and labels — only ever talks to the registry of these
 * plugins; it contains no per-tool branches or tool-name literals. To add a new
 * environment you write one plugin module and register it.
 *
 * A plugin can declare two independent capabilities:
 *  - {@link ConnectCapability}: live capture — install hooks/instructions into
 *    the host tool so prompts and edits are recorded as the student works.
 *  - {@link ImportCapability}: after-the-fact import of a conversation
 *    transcript (share link, saved page, pasted text) into the trail.
 * Most plugins have one; Claude Code has both.
 */
import type { Tool } from '../types.ts';

/** Where an integration is installed: per-user (all projects) or per-project. */
export type InstallScope = 'user' | 'project';

export interface EnvironmentPlugin {
  /** Canonical id used to tag captured events/artifacts (the {@link Tool} value). */
  id: Tool;
  /** Short name typed on the CLI, e.g. `connect <cliName>` / `import <cliName>`. */
  cliName: string;
  /** Extra accepted names for lookup (case-insensitive), e.g. 'claude-code'. */
  aliases: string[];
  /** Human-friendly label shown in reports and status. */
  label: string;
  connect?: ConnectCapability;
  import?: ImportCapability;
}

// --- Connect (live capture) -----------------------------------------------

/** A CLI flag a connect plugin understands, used to build the `connect` command. */
export interface ConnectFlag {
  /** Option key as commander exposes it (e.g. 'hooks' for `--no-hooks`). */
  name: string;
  /** The commander option spec, e.g. '--user', '--no-hooks', '--yes'. */
  flag: string;
  /** Help text. */
  description: string;
}

/** Snapshot of a connect plugin's installed state, for `status`/`start`. */
export interface ConnectStatus {
  connected: boolean;
  /** Auto-capture hooks active (tools that install hooks). Undefined = N/A. */
  hooksActive?: boolean;
  /** Managed instructions are behind the latest shipped version. */
  updateAvailable?: boolean;
}

/** Superset of options the `connect` command may pass; each plugin uses a subset. */
export interface ConnectInstallOptions {
  user?: boolean;
  project?: boolean;
  hooks?: boolean;
  extension?: boolean;
  yes?: boolean;
  force?: boolean;
  cwd?: string;
}

export interface ConnectUninstallOptions {
  user?: boolean;
  cwd?: string;
}

export interface ConnectCapability {
  /** Scopes this tool supports (drives which of --user/--project apply). */
  scopes: InstallScope[];
  /** Flags this tool's `connect` accepts (cli.ts unions these across plugins). */
  flags: ConnectFlag[];
  /** Names of flags valid for this tool (drives the "flag not valid" guard). */
  applicableFlags: readonly string[];
  /** Best-effort "is the host tool installed on this machine?" (for `setup`). */
  detect(): boolean;
  /**
   * Quiet user-scope connect performed by `showtail setup` for every detected
   * tool. Returns whether hooks were enabled, or null if this tool isn't
   * auto-connected at setup (e.g. Copilot, which is project-scoped).
   */
  autoConnect?(cwd?: string): { hooks: boolean } | null;
  /** Lines printed by `setup` when this tool is detected but not auto-connected. */
  setupGuidance?: string[];
  /** Install (or refresh) the integration. Prints its own user-facing output. */
  install(opts: ConnectInstallOptions): Promise<void>;
  /** Remove the integration. Prints its own user-facing output. */
  uninstall(opts: ConnectUninstallOptions): Promise<void>;
  /** Current installed state for `status`. */
  status(cwd?: string): ConnectStatus;
}

// --- Import (transcript) ---------------------------------------------------

/** Which set of `import` flags a plugin's subcommand exposes. */
export type ImportShape = 'share' | 'transcript';

/** Options the `import` command passes through to a plugin's importer. */
export interface ImportRunOptions {
  withResponses?: boolean;
  file?: string;
  session?: string;
  cwd?: string;
  paste?: boolean;
  clipboard?: boolean;
  yes?: boolean;
  date?: string;
  list?: boolean;
}

export interface ImportCapability {
  /** Subcommand name, e.g. 'chatgpt'. Defaults to the plugin's cliName. */
  command: string;
  /** Extra subcommand aliases (e.g. 'claude-code'). */
  aliases?: string[];
  /** One-line (or multi-line) subcommand description. */
  description: string;
  /** Whether the source argument is a share URL or an on-disk transcript target. */
  shape: ImportShape;
  /** Run the import. */
  run(source: string | undefined, opts: ImportRunOptions): Promise<void>;
}
