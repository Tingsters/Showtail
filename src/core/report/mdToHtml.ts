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
    // Any remaining `[label](target)` points at a non-http target — a `file://`
    // path or a relative file (e.g. an Antigravity plan's links into a private
    // scratch dir). Those resolve nowhere useful in a shared report and the
    // browser won't linkify them, so show just the readable label.
    html = html.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');
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

/** GitHub-style callout markers (`> [!NOTE]`) → the label shown on the box. */
const CALLOUT_LABELS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

/** One open list while parsing: its kind, indent depth, items, and `<ol>` start. */
interface OpenList {
  tag: 'ul' | 'ol';
  indent: number;
  items: string[];
  start?: number;
}

/**
 * Render a Markdown prose run (no fenced code — that's handled above) into HTML:
 * headings, nested unordered/ordered lists, (multi-line) blockquotes and GitHub
 * callouts, horizontal rules, paragraphs. Used for free-form card text, so
 * headings render as inline-styled `<div>`s rather than the document-level
 * `<h1>/<h2>` that {@link markdownToHtml} emits.
 */
function renderBlocks(md: string): string {
  return blocksToHtml(md.split('\n'));
}

/**
 * The block parser shared by {@link renderBlocks} and (recursively) blockquote
 * bodies — so a list or callout *inside* a quote renders as real structure, not
 * literal `- ` / `[!NOTE]` text.
 */
function blocksToHtml(lines: string[]): string {
  const out: string[] = [];
  // A stack of open lists, outermost first, so deeper-indented items nest inside
  // the previous item rather than flattening into siblings.
  const stack: OpenList[] = [];
  let para: string[] = [];

  const renderList = (l: OpenList): string => {
    const startAttr =
      l.tag === 'ol' && l.start !== undefined && l.start !== 1
        ? ` start="${l.start}"`
        : '';
    return `<${l.tag}${startAttr}>${l.items.join('')}</${l.tag}>`;
  };
  // Close the innermost list, nesting its HTML inside the parent's last <li> (or
  // emitting it at top level when it's the outermost list).
  const closeTopList = () => {
    const l = stack.pop();
    if (!l) return;
    const html = renderList(l);
    const parent = stack[stack.length - 1];
    if (parent) {
      const last = parent.items.length - 1;
      parent.items[last] = parent.items[last]!.replace(/<\/li>$/, `${html}</li>`);
    } else {
      out.push(html);
    }
  };
  const flushLists = () => {
    while (stack.length) closeTopList();
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inlineMarkdown(l, true)).join('<br>')}</p>`);
      para = [];
    }
  };
  // Add a list item at `indent`, opening/closing nested lists as the depth shifts.
  const addItem = (tag: 'ul' | 'ol', indent: number, html: string, num?: number) => {
    flushPara();
    while (stack.length && stack[stack.length - 1]!.indent > indent) closeTopList();
    const top = stack[stack.length - 1];
    if (!top || top.indent < indent) {
      stack.push({ tag, indent, items: [], start: tag === 'ol' ? num : undefined });
    } else if (top.indent === indent && top.tag !== tag) {
      closeTopList();
      stack.push({ tag, indent, items: [], start: tag === 'ol' ? num : undefined });
    }
    stack[stack.length - 1]!.items.push(`<li>${html}</li>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\s+$/, '');
    const trimmed = line.trim();
    let mm: RegExpMatchArray | null;

    if (trimmed === '') {
      flushLists();
      flushPara();
    } else if (/^\s*>/.test(line)) {
      // Coalesce the whole run of `>` lines into one quote, strip the markers, and
      // render the inner text as blocks (lists/paragraphs inside the quote work).
      flushLists();
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      i--; // the for-loop will re-increment past the last quote line
      const co = inner[0]
        ?.trim()
        .match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (co) {
        const type = co[1]!.toUpperCase();
        inner[0] = co[2] ?? '';
        if (inner[0]!.trim() === '') inner.shift();
        out.push(
          `<blockquote class="callout callout-${type.toLowerCase()}">` +
            `<p class="callout-label">${CALLOUT_LABELS[type]}</p>` +
            `${blocksToHtml(inner)}</blockquote>`,
        );
      } else {
        out.push(`<blockquote>${blocksToHtml(inner)}</blockquote>`);
      }
    } else if ((mm = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushLists();
      flushPara();
      out.push(`<div class="md-h">${inlineMarkdown(mm[2]!, true)}</div>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushLists();
      flushPara();
      out.push('<hr>');
    } else if ((mm = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      addItem('ul', mm[1]!.length, inlineMarkdown(mm[2]!, true));
    } else if ((mm = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      addItem('ol', mm[1]!.length, inlineMarkdown(mm[3]!, true), parseInt(mm[2]!, 10));
    } else {
      flushLists();
      para.push(line);
    }
  }
  flushLists();
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
