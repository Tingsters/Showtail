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
 * monospace code box, and the prose around it is rendered as a small Markdown
 * subset (headings, lists, tables, quotes, rules, bold/italic/code/links).
 * Everything is escaped before formatting, so no script can slip through, and
 * only http/https links become anchors.
 *
 * Fences are handled by the block parser rather than split out of the text
 * first. Pre-splitting tore a fenced block out of whatever contained it: a
 * quoted code sample became two blockquotes with the box stranded between them
 * *and* kept its `>` markers inside the code, and a fenced block under a list
 * item split the list in two and left the code at top level.
 */
export function renderRichText(text: string): string {
  return renderBlocks(text);
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

/** Which way a table column's cells are aligned, per its separator row. */
type ColumnAlign = 'left' | 'center' | 'right' | null;

/**
 * Drop up to `n` leading spaces, so code fenced inside a list item is not shown
 * with the indentation that merely positioned it under its bullet.
 */
function stripIndent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === ' ') i++;
  return line.slice(i);
}

/** A line that could be a table row: pipe-delimited, outer pipes required. */
function isTableRow(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|.*\|\s*$/.test(line);
}

/**
 * The `|---|:--:|` line under a table's header. Requiring it is what makes table
 * detection safe: without it, any prose containing pipes would become a table.
 */
function isTableSeparator(line: string | undefined): boolean {
  if (!isTableRow(line)) return false;
  return splitRow(line!).every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

/** Column alignments from a separator row: `:--` left, `--:` right, `:--:` centre. */
function parseAlignments(separator: string): ColumnAlign[] {
  return splitRow(separator).map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * Split a row into cells on unescaped pipes, dropping the empties the outer
 * pipes produce. `\|` is a literal pipe in a cell, so it must not split.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|'; // escaped pipe: keep it, don't split here
      i++;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  // The leading and trailing pipes each yield an empty cell; drop just those.
  if (cells.length && cells[0]!.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells;
}

/**
 * Render a parsed table. Rows are padded or truncated to the header's width so
 * ragged input degrades into a valid table instead of broken markup, and every
 * cell goes through `inlineMarkdown`, which escapes it and applies the same
 * bold/code/link rules as the rest of the document.
 */
function tableHtml(header: string[], body: string[][], aligns: ColumnAlign[]): string {
  const columns = header.length;
  const cell = (tag: 'th' | 'td', text: string, i: number): string => {
    const align = aligns[i];
    const style = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${inlineMarkdown(text.trim(), true)}</${tag}>`;
  };
  const row = (cells: string[], tag: 'th' | 'td'): string => {
    const padded = Array.from({ length: columns }, (_, i) => cells[i] ?? '');
    return `<tr>${padded.map((c, i) => cell(tag, c, i)).join('')}</tr>`;
  };
  const head = `<thead>${row(header, 'th')}</thead>`;
  const rows = body.map((r) => row(r, 'td')).join('');
  const bodyHtml = rows ? `<tbody>${rows}</tbody>` : '';
  // The wrapper scrolls a wide table instead of letting it burst the card.
  return `<div class="md-table-wrap"><table class="md-table">${head}${bodyHtml}</table></div>`;
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
  // Text indented under the current list item — a continuation of that item
  // rather than a new block. Buffered so consecutive lines become one paragraph.
  let itemPara: string[] = [];

  /** Tuck `html` inside the list's most recent `<li>`, before its closing tag. */
  const appendToItem = (l: OpenList, html: string) => {
    const last = l.items.length - 1;
    if (last < 0) return;
    l.items[last] = l.items[last]!.replace(/<\/li>$/, `${html}</li>`);
  };
  // Close off any continuation text into the item it belongs to. Must run before
  // a list closes or a new item opens, or the text lands in the wrong place.
  const flushItemPara = () => {
    const top = stack[stack.length - 1];
    if (itemPara.length && top) {
      appendToItem(
        top,
        `<p>${itemPara.map((l) => inlineMarkdown(l, true)).join('<br>')}</p>`,
      );
    }
    itemPara = [];
  };
  // Close the innermost list, nesting its HTML inside the parent's last <li> (or
  // emitting it at top level when it's the outermost list).
  const closeTopList = () => {
    const l = stack.pop();
    if (!l) return;
    const html = renderList(l);
    const parent = stack[stack.length - 1];
    if (parent) {
      appendToItem(parent, html);
    } else {
      out.push(html);
    }
  };
  const flushLists = () => {
    flushItemPara();
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
    flushItemPara();
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
      // A blank line ends a paragraph but does *not* end an open list: a list
      // item may continue after one ("loose" lists), and whether it does is
      // decided by what comes next — an indented line continues the item, an
      // unindented one closes the list.
      flushItemPara();
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
    } else if ((mm = line.match(/^(\s*)(`{3,})([\w+#.-]*)\s*$/))) {
      // A fenced code block. Handled here, inside the block parser, so it stays
      // where it was written — inside its blockquote, or attached to the list
      // item it documents. The closing fence must be at least as long as the
      // opening one, so a ```` block can contain ``` lines (a Markdown sample).
      const indent = mm[1]!.length;
      const lang = mm[3] ?? '';
      const closer = new RegExp('^\\s*`{' + mm[2]!.length + ',}\\s*$');
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i] ?? '')) {
        body.push(stripIndent(lines[i] ?? '', indent));
        i++;
      }
      // `i` now sits on the closing fence, or past the end if it was never
      // closed — either way the block is emitted rather than dropped.
      const box = codeBox(body.join('\n'), lang);
      const top = stack[stack.length - 1];
      if (top && indent > top.indent && top.items.length > 0) {
        // Indented past the list marker, so it belongs to the open item — after
        // whatever prose already continued that item.
        flushPara();
        flushItemPara();
        appendToItem(top, box);
      } else {
        flushLists();
        flushPara();
        out.push(box);
      }
    } else if ((mm = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushLists();
      flushPara();
      out.push(`<div class="md-h">${inlineMarkdown(mm[2]!, true)}</div>`);
    } else if (isTableRow(line) && isTableSeparator(lines[i + 1])) {
      // A GitHub table. The separator row is required, which is what keeps a
      // shell pipeline (`grep foo | wc -l`) or a sentence containing a pipe
      // from being swallowed as a table.
      flushLists();
      flushPara();
      const aligns = parseAlignments(lines[i + 1]!);
      const header = splitRow(line);
      const body: string[][] = [];
      i += 2; // past the header and the separator
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitRow(lines[i]!));
        i++;
      }
      i--; // the for-loop will re-increment past the last row
      out.push(tableHtml(header, body, aligns));
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushLists();
      flushPara();
      out.push('<hr>');
    } else if ((mm = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      addItem('ul', mm[1]!.length, inlineMarkdown(mm[2]!, true));
    } else if ((mm = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      addItem('ol', mm[1]!.length, inlineMarkdown(mm[3]!, true), parseInt(mm[2]!, 10));
    } else {
      const top = stack[stack.length - 1];
      const indent = line.length - line.trimStart().length;
      if (top && top.items.length > 0 && indent > top.indent) {
        // Indented past the marker of the open item, so it continues that item
        // instead of ending the list — which is what used to happen, splitting
        // one list into two with the text stranded between them.
        itemPara.push(trimmed);
      } else {
        flushLists();
        para.push(line);
      }
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
