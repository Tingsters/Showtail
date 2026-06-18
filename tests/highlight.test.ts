import { describe, expect, test } from 'bun:test';
import { highlightCode } from '../src/core/highlight.ts';

describe('highlightCode', () => {
  test('wraps keywords in a tok-kw span', () => {
    expect(highlightCode('const a = 1;')).toContain('<span class="tok-kw">const</span>');
    expect(highlightCode('return x')).toContain('<span class="tok-kw">return</span>');
  });

  test('colors strings, numbers, and comments', () => {
    expect(highlightCode('"hello"')).toContain('<span class="tok-str">"hello"</span>');
    expect(highlightCode('x = 42')).toContain('<span class="tok-num">42</span>');
    expect(highlightCode('// a note')).toContain(
      '<span class="tok-com">// a note</span>',
    );
    expect(highlightCode('# py comment')).toContain(
      '<span class="tok-com"># py comment</span>',
    );
  });

  test('marks an identifier called as a function', () => {
    expect(highlightCode('print(x)')).toContain('<span class="tok-fn">print</span>');
    // A plain identifier not followed by "(" is left unhighlighted.
    const plain = highlightCode('value');
    expect(plain).toBe('value');
  });

  test('escapes HTML metacharacters and never emits a raw tag', () => {
    const out = highlightCode('a < b && c > d');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
    expect(out).toContain('&amp;&amp;');
    expect(out).not.toContain('<b');
    // A would-be tag from user code is escaped, not emitted.
    expect(highlightCode('<script>')).not.toContain('<script>');
  });

  test('preserves leading indentation', () => {
    const out = highlightCode('    return x');
    expect(out.startsWith('    ')).toBe(true);
  });

  test('a # or // inside a string is not treated as a comment', () => {
    const out = highlightCode('url = "http://x#y"');
    expect(out).toContain('<span class="tok-str">"http://x#y"</span>');
    expect(out).not.toContain('tok-com');
  });
});
