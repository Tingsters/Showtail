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
  /**
   * Runtime capture adapter. Present only for tools with auto-capture hooks
   * (Copilot, which captures via its VS Code extension, has none). This is the
   * boundary that keeps the hook dispatcher tool-agnostic: it turns the host's
   * raw payload into a {@link NormalizedHookEvent} and owns all tool-specific
   * payload/transcript knowledge.
   */
  hooks?: HookAdapter;
}

// --- Runtime capture (the tool-agnostic hook boundary) --------------------

/**
 * A hook event normalized across tools. The hook dispatcher operates only on
 * this shape — it never inspects a raw payload or branches on a tool name.
 */
export interface NormalizedHookEvent {
  /** The host tool's own session id (Claude/Gemini `session_id`, …), if any. */
  nativeSessionId?: string;
  /** The submitted prompt text (user-prompt event), if any. */
  prompt?: string;
  /** Repo paths the edit tool touched (post-edit event). */
  editedFiles: string[];
  /** AI-suggested diff/code for the edit, if captured. */
  suggestedDiff?: string;
}

/** One message of a normalized transcript used for stop-time reconciliation. */
export interface HookTranscriptMessage {
  /** 'user' | 'assistant' | 'decision' | 'plan' (others, e.g. 'edit', are ignored). */
  role: string;
  text: string;
  timestamp?: string;
  sourceId: string;
  /** For a 'plan' message: whether the student approved it. */
  approved?: boolean;
}

/** A normalized conversation transcript, in order. */
export interface HookTranscript {
  sessionId?: string;
  messages: HookTranscriptMessage[];
}

/**
 * A real on-disk plan file a tool wrote for the session (e.g. Antigravity's
 * `brain/<id>/plan.md`). The hook dispatcher materializes this into the trail
 * and links it from the report; the discovery of *where* a tool keeps its plan
 * files is the only tool-specific part, exactly like {@link HookAdapter.getTranscript}.
 */
export interface DiscoveredPlanFile {
  /** Absolute source path on disk (provenance only; never linked directly). */
  absPath: string;
  /** The plan markdown read from disk. */
  content: string;
  /** Stable id for the saved copy + dedup, e.g. `agy-plan:<conversationId>`. */
  sourceId: string;
  /** The tool's own session id this plan belongs to, for matching to a session. */
  nativeSessionId?: string;
}

export interface HookAdapter {
  /** Parse this host's raw stdin payload into the normalized shape (best-effort). */
  parse(raw: unknown): NormalizedHookEvent;
  /** Path patterns whose edits must NOT be snapshotted (this tool's own dirs). */
  internalPaths: RegExp[];
  /** Patterns to force-include even if internal (e.g. .claude/worktrees checkouts). */
  includePaths?: RegExp[];
  /**
   * On stop, return a transcript to reconcile AI replies/decisions from, or null
   * if this tool provides none (then stop is a no-op). Only the "how to obtain a
   * transcript" step is tool-specific; the reconcile itself is generic.
   */
  getTranscript?(raw: unknown, root: string): HookTranscript | null;
  /**
   * On stop, return the real on-disk plan file(s) this tool wrote for the
   * session, or `[]` if none. The reconcile then saves them as linkable plan
   * artifacts; tools that keep their plan only in the transcript (Claude Code's
   * `ExitPlanMode`, Codex's `update_plan`) omit this and the plan markdown
   * already on the transcript is materialized instead. Best-effort; never throws.
   */
  planFiles?(raw: unknown, root: string): DiscoveredPlanFile[];
  /**
   * Run the transcript reconcile on the `post-edit` hook too, not only on `Stop`.
   * Set for hosts whose runtime never fires a stop/end hook (the Antigravity IDE
   * only dispatches `PostToolUse`), so prompts/replies/plans are still captured.
   * Safe because the reconcile dedups by sourceId; default (unset) = Stop-only.
   */
  reconcileOnPostEdit?: boolean;
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
