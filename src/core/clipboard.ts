/**
 * Read text from the system clipboard, so a student can import a conversation
 * by copying it in the browser rather than pasting it into the terminal —
 * pasting multi-line text into a shell (PowerShell especially) runs each line
 * as a command, which never works. Zero dependencies: we spawn the platform's
 * own clipboard tool, mirroring how `git.ts` shells out.
 */
import { execFileSync } from 'node:child_process';

/** Clipboards can hold a long conversation; don't cap it at the 1 MB default. */
const MAX_BUFFER = 50 * 1024 * 1024;

/** Run a clipboard command and return its stdout, or null if it isn't available. */
function tryRead(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  } catch {
    return null;
  }
}

/**
 * Return the clipboard's text contents. Throws a clear, actionable error when no
 * clipboard tool is available (so the caller can point the user at `--file`).
 */
export function readClipboard(): string {
  if (process.platform === 'win32') {
    const out = tryRead('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Clipboard -Raw',
    ]);
    if (out !== null) return out;
  } else if (process.platform === 'darwin') {
    const out = tryRead('pbpaste', []);
    if (out !== null) return out;
  } else {
    // Linux/other: try the common clipboard tools in turn.
    for (const [cmd, args] of [
      ['wl-paste', ['--no-newline']],
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['--clipboard', '--output']],
    ] as Array<[string, string[]]>) {
      const out = tryRead(cmd, args);
      if (out !== null) return out;
    }
  }

  throw new Error(
    "Couldn't read your clipboard on this system.\n" +
      'Save the conversation to a text file and import it with --file <path> instead.',
  );
}
