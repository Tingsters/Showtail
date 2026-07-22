/**
 * The post-report "open it?" menu. A tiny single-keypress prompt: press a hotkey
 * (or a number, when several reports were written) to act, Esc/Ctrl-C to skip. This
 * is the one place Showtail reads the keyboard in raw mode — every other prompt is
 * line-based `readline` — because we want a single key with no Enter and a bare Esc
 * to skip, which line mode can't capture. It is fully TTY-guarded so a non-interactive
 * run (piped, CI, an AI agent, a hook) never blocks on input.
 */

/** One report the menu can open: a human label and the file to launch. */
export interface OpenableReport {
  label: string;
  path: string;
}

/** The user's choice from the open menu. */
export type OpenChoice =
  | { kind: 'open'; path: string } // open this report once; don't remember
  | { kind: 'always' } // remember "always" and open the primary report now
  | { kind: 'never' } // remember "never"; don't open
  | { kind: 'skip' }; // Esc/Ctrl-C/anything else: do nothing, remember nothing

/** Build the menu text shown on stderr (solo → o/a/n, multiple → a numbered list). */
function menuText(reports: OpenableReport[], primary: OpenableReport): string {
  const alwaysLabel = primary.label === 'team' ? '(a) always open team' : '(a) always';
  if (reports.length <= 1) {
    return (
      '\nOpen it in your browser?\n' +
      `  (o) once   ${alwaysLabel}   (n) never, don't ask again\n` +
      '  ↓ press a key  ·  Esc to skip '
    );
  }
  // Only the first 9 are single-key selectable (digits 1–9).
  const list = reports
    .slice(0, 9)
    .map((r, i) => `  ${i + 1}) ${r.label}`)
    .join('');
  return (
    '\nReports written:\n' +
    `${list}\n\n` +
    'Open one in your browser?\n' +
    `  1–${Math.min(reports.length, 9)} open that report once\n` +
    `  ${alwaysLabel}   (n) never, don't ask again\n` +
    '  Esc to skip '
  );
}

/** Map a keypress to a choice; anything unmapped (including Esc/Ctrl-C) skips. */
export function keyToChoice(
  key: string,
  reports: OpenableReport[],
  primary: OpenableReport,
): OpenChoice {
  if (key === '\x03') return { kind: 'skip' }; // Ctrl-C: skip the menu (not abort)
  const ch = key[0] ?? '';
  if (ch === '\x1b') return { kind: 'skip' }; // Esc, or any escape sequence (arrows, …)
  const lower = ch.toLowerCase();
  if (lower === 'a') return { kind: 'always' };
  if (lower === 'n') return { kind: 'never' };
  if (reports.length <= 1) {
    if (lower === 'o') return { kind: 'open', path: primary.path };
    return { kind: 'skip' };
  }
  if (ch >= '1' && ch <= '9') {
    const idx = ch.charCodeAt(0) - '1'.charCodeAt(0);
    if (idx < reports.length) return { kind: 'open', path: reports[idx]!.path };
  }
  return { kind: 'skip' };
}

/**
 * Show the open menu and resolve with the user's choice. Returns `{ kind: 'skip' }`
 * immediately (never prompting) unless both stdin and stdout are interactive TTYs.
 */
export function promptOpenReport(
  reports: OpenableReport[],
  primary: OpenableReport,
): Promise<OpenChoice> {
  const { stdin, stdout, stderr } = process;
  if (!(stdin.isTTY && stdout.isTTY)) return Promise.resolve({ kind: 'skip' });

  stderr.write(menuText(reports, primary));

  return new Promise<OpenChoice>((resolve) => {
    const onData = (data: Buffer | string) => {
      cleanup();
      stderr.write('\n');
      resolve(keyToChoice(data.toString('utf8'), reports, primary));
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.resume();
    stdin.setEncoding('utf8');
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.once('data', onData);
  });
}
