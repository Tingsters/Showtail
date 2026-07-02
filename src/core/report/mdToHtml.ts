import { escapeHtml } from '../html.ts';
import { highlightCode } from '../highlight.ts';

/**
 * Escape a run, then apply inline Markdown. The basic set (code, `**bold**`,
 * `_italic_`) is always applied; `extended` additionally enables `*italic*` and
 * http/https links — used for free-form prompt/AI text in the turn cards, but not
 * for the report skeleton, whose text is generated and must not gain surprise
 * emphasis from a stray `*` or `[...](...)` in (e.g.) a project name.
 */
function inlineMarkdown(s: string, extended: boolean): string {
  let html = escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  if (extended) {
    html = html.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s.,)])/g, '$1<em>$2</em>');
  }
  html = html.replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,)])/g, '$1<em>$2</em>');
  if (extended) {
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    );
  }
  return html;
}

/** A monospace code box (no view-time JS) with an optional language label. */
function codeBox(code: string, lang: string): string {
  const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : '';
  // Syntax-highlight per line (highlightCode escapes), sharing the diff's theme.
  const body = code.replace(/\n$/, '').split('\n').map(highlightCode).join('\n');
  return `${label}<pre class="codeblock"><code>${body}</code></pre>`;
}

/**
 * Render prompt/AI text (Markdown) for a turn card: fenced code becomes a real
 * monospace code box, and the prose between fences is rendered as a small
 * Markdown subset (headings, lists, quotes, rules, bold/italic/code/links).
 * Everything is escaped before formatting, so no script can slip through, and
 * only http/https links become anchors.
 */
export function renderRichText(text: string): string {
  const out: string[] = [];
  const fence = /```([\w+#.-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    out.push(renderBlocks(text.slice(last, m.index)));
    out.push(codeBox(m[2] ?? '', m[1] ?? ''));
    last = fence.lastIndex;
  }
  out.push(renderBlocks(text.slice(last)));
  return out.join('');
}

/**
 * Render a Markdown prose run (no fenced code — that's handled above) into HTML:
 * headings, unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
 * Used for free-form card text, so headings render as inline-styled `<div>`s
 * rather than the document-level `<h1>/<h2>` that {@link markdownToHtml} emits.
 */
function renderBlocks(md: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inlineMarkdown(l, true)).join('<br>')}</p>`);
      para = [];
    }
  };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let mm: RegExpMatchArray | null;
    if (line.trim() === '') {
      flushList();
      flushPara();
    } else if ((mm = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushList();
      flushPara();
      out.push(`<div class="md-h">${inlineMarkdown(mm[2]!, true)}</div>`);
    } else if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(
        `<li>${inlineMarkdown(line.replace(/^\s*[-*+]\s+/, ''), true)}</li>`,
      );
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(
        `<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''), true)}</li>`,
      );
    } else if (/^>\s?/.test(line)) {
      flushList();
      flushPara();
      out.push(
        `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''), true)}</blockquote>`,
      );
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList();
      flushPara();
      out.push('<hr>');
    } else {
      flushList();
      para.push(line);
    }
  }
  flushList();
  flushPara();
  return out.join('');
}

/**
 * Convert the small Markdown subset that `renderMarkdown` emits into the report's
 * HTML skeleton. Deliberately minimal (no dependency): document headings
 * (`<h1>/<h2>`), unordered lists, blockquotes, paragraphs, and inline
 * bold/italic/code. Source text is HTML-escaped *before* inline formatting is
 * applied, so embedded `<script>` is neutralized; the usual Markdown ambiguity
 * (a literal `_` or `**` inside user text) is acceptable here.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let listItems: string[] | null = null;
  let quoteLines: string[] | null = null;

  const flushList = () => {
    if (listItems) {
      out.push('<ul>', ...listItems, '</ul>');
      listItems = null;
    }
  };
  const flushQuote = () => {
    if (quoteLines) {
      out.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
      quoteLines = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.startsWith('## ')) {
      flushList();
      flushQuote();
      out.push(`<h2>${inlineMarkdown(line.slice(3), false)}</h2>`);
    } else if (line.startsWith('# ')) {
      flushList();
      flushQuote();
      out.push(`<h1>${inlineMarkdown(line.slice(2), false)}</h1>`);
    } else if (line.startsWith('> ')) {
      flushList();
      (quoteLines ??= []).push(inlineMarkdown(line.slice(2), false));
    } else if (line.startsWith('- ')) {
      flushQuote();
      listItems ??= [];
      // A bullet may carry an indented continuation line (the metadata), joined
      // to the item with a `<br>` to mirror the Markdown hard line break.
      let item = inlineMarkdown(line.slice(2).replace(/\s+$/, ''), false);
      let next = lines[i + 1];
      while (next !== undefined && /^\s{2,}\S/.test(next)) {
        item += `<br>${inlineMarkdown(next.trim(), false)}`;
        i++;
        next = lines[i + 1];
      }
      listItems.push(`<li>${item}</li>`);
    } else if (line.trim() === '') {
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      out.push(`<p>${inlineMarkdown(line, false)}</p>`);
    }
  }
  flushList();
  flushQuote();
  return out.join('\n');
}
