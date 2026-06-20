import { describe, expect, test } from 'bun:test';
import { fileLink } from '../src/core/terminal.ts';

describe('fileLink', () => {
  test('returns the plain label when hyperlinks are off (non-TTY)', () => {
    const out = fileLink('/abs/report.html', undefined, false);
    expect(out).toBe('/abs/report.html');
    expect(out).not.toContain('\x1b');
  });

  test('wraps the label in an OSC 8 file:// hyperlink when forced on', () => {
    const out = fileLink('C:/Users/me/report.html', 'report.html', true);
    expect(out).toContain('\x1b]8;;'); // OSC 8 introducer
    expect(out).toContain('file://'); // a file URL target
    expect(out).toContain('report.html'); // the visible label survives
    // Shape: <OSC>url<BEL>label<OSC><BEL>
    expect(out).toMatch(/\x1b\]8;;file:\/\/[^\x07]+\x07report\.html\x1b\]8;;\x07/);
  });

  test('defaults the label to the path itself', () => {
    expect(fileLink('/abs/report.html', undefined, false)).toBe('/abs/report.html');
  });
});
