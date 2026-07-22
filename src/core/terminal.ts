/**
 * Small terminal helpers for surfacing a written file to the user: a clickable
 * hyperlink (for terminals that support it) and an opener (for the rest). Both
 * are zero-dependency and mirror how `clipboard.ts` / `git.ts` shell out.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** How to surface a file path in the terminal, cheapest-clickable first. */
export type LinkMode =
  | 'plain' // not a TTY (piped/redirected/captured): bare label, no escapes.
  | 'osc8' // terminal supports OSC 8 hyperlinks: a real clickable hyperlink.
  | 'url'; // TTY without OSC 8 (Terminal.app, xterm): a bare file:// URL.

/**
 * Detect whether this terminal renders OSC 8 hyperlinks. There's no query for
 * this, so we go by the env markers the supporting emulators set. Notably absent:
 * Apple_Terminal (macOS Terminal.app) and xterm, which strip OSC 8 and would show
 * an inert path — those fall through to `false` and get a `file://` URL instead.
 */
export function supportsOsc8(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WT_SESSION) return true; // Windows Terminal
  if (env.KITTY_WINDOW_ID) return true; // kitty
  if (env.VTE_VERSION && Number(env.VTE_VERSION) >= 5000) return true; // VTE 0.50+ (GNOME Terminal, Tilix, …)
  switch (env.TERM_PROGRAM) {
    case 'iTerm.app':
    case 'WezTerm':
    case 'vscode':
    case 'Hyper':
    case 'ghostty':
      return true;
  }
  return false;
}

/** Pick the link mode for the current stdout: plain if piped, else osc8/url. */
function detectLinkMode(): LinkMode {
  if (!(process.stdout.isTTY ?? false)) return 'plain';
  return supportsOsc8() ? 'osc8' : 'url';
}

/**
 * Render a local file path as the most clickable thing the terminal can show:
 *
 * - `osc8` — an OSC 8 hyperlink wrapping `label` (Windows Terminal, iTerm2, VS
 *   Code, kitty, GNOME Terminal, WezTerm, Ghostty, …). Renders clickable and opens
 *   the file.
 * - `url` — a bare `file://` URL, for TTYs without OSC 8 support (macOS
 *   Terminal.app, xterm). These emulators auto-linkify a `file://` URL and open it
 *   on ⌘/Ctrl-click; where that fails it's still a copy-pasteable URL — better than
 *   the inert path an OSC 8 sequence would leave once stripped.
 * - `plain` — the bare label, when stdout is not an interactive TTY
 *   (piped/redirected/captured), so escape codes never leak into files or logs.
 */
export function fileLink(
  absPath: string,
  label: string = absPath,
  mode: LinkMode = detectLinkMode(),
): string {
  if (mode === 'plain') return label;
  const url = pathToFileURL(absPath).href; // file:///C:/Users/… — handles Windows + URL-encoding.
  if (mode === 'url') return url;
  const OSC = '\x1b]8;;';
  const BEL = '\x07'; // The most broadly compatible OSC 8 terminator.
  return `${OSC}${url}${BEL}${label}${OSC}${BEL}`;
}

/**
 * Open a file in the OS default app (a browser, for an HTML report). Best-effort:
 * never throws and never blocks — if no opener exists, the printed (clickable)
 * path is the fallback. Uses `spawn().unref()` so the launched app doesn't tie
 * the CLI's lifetime, and `spawn` (not `execFileSync`) sidesteps the Windows
 * quirk where `start`/`explorer` return non-zero even on success.
 */
export function openInDefaultApp(absPath: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32'
        ? // `start`'s first quoted arg is the window title, hence the empty ''.
          ['cmd', ['/c', 'start', '', absPath]]
        : process.platform === 'darwin'
          ? ['open', [absPath]]
          : ['xdg-open', [absPath]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opener missing or blocked — nothing to do; the printed path still works.
  }
}
