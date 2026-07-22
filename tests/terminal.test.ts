import { describe, expect, test } from 'bun:test';
import { fileLink, supportsOsc8 } from '../src/core/terminal.ts';

describe('fileLink', () => {
  test('returns the plain label in plain mode (non-TTY)', () => {
    const out = fileLink('/abs/report.html', undefined, 'plain');
    expect(out).toBe('/abs/report.html');
    expect(out).not.toContain('\x1b');
  });

  test('wraps the label in an OSC 8 file:// hyperlink in osc8 mode', () => {
    const out = fileLink('C:/Users/me/report.html', 'report.html', 'osc8');
    expect(out).toContain('\x1b]8;;'); // OSC 8 introducer
    expect(out).toContain('file://'); // a file URL target
    expect(out).toContain('report.html'); // the visible label survives
    // Shape: <OSC>url<BEL>label<OSC><BEL>
    expect(out).toMatch(/\x1b\]8;;file:\/\/[^\x07]+\x07report\.html\x1b\]8;;\x07/);
  });

  test('emits a bare, escape-free file:// URL in url mode (Terminal.app, xterm)', () => {
    const out = fileLink('/abs/report.html', 'report.html', 'url');
    expect(out).toBe('file:///abs/report.html');
    expect(out).not.toContain('\x1b'); // no OSC 8 sequence to be stripped/left inert
  });

  test('defaults the label to the path itself', () => {
    expect(fileLink('/abs/report.html', undefined, 'plain')).toBe('/abs/report.html');
  });
});

describe('supportsOsc8', () => {
  test('true for terminals known to render OSC 8 hyperlinks', () => {
    expect(supportsOsc8({ WT_SESSION: '1' })).toBe(true); // Windows Terminal
    expect(supportsOsc8({ KITTY_WINDOW_ID: '1' })).toBe(true); // kitty
    expect(supportsOsc8({ VTE_VERSION: '6003' })).toBe(true); // GNOME Terminal / VTE 0.60
    expect(supportsOsc8({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(supportsOsc8({ TERM_PROGRAM: 'vscode' })).toBe(true);
    expect(supportsOsc8({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
  });

  test('false for terminals that strip OSC 8', () => {
    expect(supportsOsc8({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false); // macOS Terminal.app
    expect(supportsOsc8({ TERM: 'xterm-256color' })).toBe(false);
    expect(supportsOsc8({})).toBe(false);
    expect(supportsOsc8({ VTE_VERSION: '4600' })).toBe(false); // VTE too old
  });
});
