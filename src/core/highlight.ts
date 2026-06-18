/**
 * A tiny, dependency-free syntax highlighter used at report-build time, so the
 * report stays a single self-contained file with no view-time JavaScript. It is
 * deliberately language-agnostic: one shared set of common keywords plus
 * strings, comments, numbers, and function-call names. That keeps the coloring
 * consistent everywhere code appears (AI edit diffs and chat code blocks) and
 * "good enough" across the languages students paste.
 *
 * Known limitation: it tokenizes one line at a time, so a string or block
 * comment that spans multiple lines is only colored on each line in isolation.
 */

/** Common keywords across the languages students tend to use. */
const KEYWORDS = new Set([
  'abstract',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'bool',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'def',
  'default',
  'del',
  'delete',
  'do',
  'double',
  'elif',
  'else',
  'enum',
  'except',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'global',
  'goto',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'int',
  'interface',
  'is',
  'lambda',
  'let',
  'long',
  'match',
  'namespace',
  'new',
  'nil',
  'none',
  'None',
  'not',
  'null',
  'or',
  'override',
  'package',
  'pass',
  'private',
  'protected',
  'public',
  'raise',
  'readonly',
  'return',
  'self',
  'short',
  'sizeof',
  'static',
  'str',
  'string',
  'struct',
  'super',
  'switch',
  'template',
  'this',
  'throw',
  'throws',
  'trait',
  'true',
  'try',
  'type',
  'typedef',
  'typeof',
  'union',
  'unsigned',
  'using',
  'val',
  'var',
  'void',
  'volatile',
  'while',
  'with',
  'yield',
]);

/** Escape the characters unsafe in HTML text content. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${esc(text)}</span>`;
}

// One token at a time, leftmost match wins; alternatives tried in this order so
// a `#`/`//` inside a string is not mistaken for a comment (the string opens
// first at its quote). Strings tolerate being unterminated (per-line).
const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;

/**
 * Highlight a single line of code, returning HTML-escaped text with tokens
 * wrapped in `tok-*` spans. Leading whitespace (indentation) is preserved.
 */
export function highlightCode(line: string): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    out += esc(line.slice(last, m.index)); // gap (incl. indentation/operators)
    const text = m[0];
    if (m[1] || m[2]) out += span('tok-com', text);
    else if (m[3]) out += span('tok-str', text);
    else if (m[4]) out += span('tok-num', text);
    else {
      // identifier
      if (KEYWORDS.has(text)) out += span('tok-kw', text);
      else if (line[TOKEN_RE.lastIndex] === '(') out += span('tok-fn', text);
      else out += esc(text);
    }
    last = TOKEN_RE.lastIndex;
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++; // guard against zero-width
  }
  out += esc(line.slice(last));
  return out;
}
