/**
 * Small terminal helpers for surfacing a written file to the user: a clickable
 * hyperlink (for terminals that support it) and an opener (for the rest). Both
 * are zero-dependency and mirror how `clipboard.ts` / `git.ts` shell out.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Wrap `label` in an OSC 8 terminal hyperlink pointing at a local file, so
 * supporting terminals (Windows Terminal, VS Code, iTerm2, …) render it
 * clickable and open the file. When stdout is not an interactive TTY
 * (piped/redirected/captured), returns the plain label so escape codes never
 * leak into files or logs.
 */
export function fileLink(
  absPath: string,
  label: string = absPath,
  hyperlinks: boolean = process.stdout.isTTY ?? false,
): string {
  if (!hyperlinks) return label;
  const url = pathToFileURL(absPath).href; // file:///C:/Users/… — handles Windows + URL-encoding.
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
