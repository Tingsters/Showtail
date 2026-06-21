import REPORT_CSS from '../../../assets/report/report.css' with { type: 'text' };
import TIMEZONE_JS from '../../../assets/report/timezone.js' with { type: 'text' };
import type { ReportData } from '../../types.ts';
import { escapeHtml, firstLine } from '../html.ts';
import { highlightCode } from '../highlight.ts';
import { toolLabel } from './data.ts';
import { buildMarkdown, fileHref, TURNS_PLACEHOLDER } from './markdown.ts';
import { markdownToHtml, renderRichText } from './mdToHtml.ts';
import { TIME_TOKEN, timeTag } from './time.ts';

/**
 * Render a report as a standalone HTML document. Most of the document is a
 * rendering of the Markdown returned by `renderMarkdown`; the "Prompts & AI
 * exchanges" section is rendered directly to interactive `<details>` cards
 * (which the Markdown subset can't express) and spliced in. The file stays a
 * single self-contained document with no network calls; the only script is a
 * small inline one that re-renders timestamps in the viewer's chosen timezone.
 * Everything degrades gracefully without JavaScript: the cards use native HTML
 * disclosure, and timestamps fall back to their static UTC text.
 */
export function renderHtml(data: ReportData): string {
  const base = `Showtail Report — ${data.displayName}`;
  const title = data.scope ? `${base} — ${data.scope.name}` : base;
  const body = markdownToHtml(buildMarkdown(data, true))
    // Swap the timestamp tokens emitted in HTML mode for real <time> elements
    // FIRST, before splicing in the turn cards. The cards embed <time> directly
    // (they carry no tokens), and their escaped prompt/AI text can itself contain
    // the sentinel — Showtail captures its own sessions — so running this global
    // regex after the splice would match and corrupt that content.
    .replace(TIME_TOKEN, (_m, iso: string) => timeTag(iso))
    .replace(`<p>${TURNS_PLACEHOLDER}</p>`, turnsHtml(data));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${REPORT_CSS}</style>
</head>
<body>
<div class="st-tzbar">Times shown in <select id="st-tz" aria-label="Display timezone"></select></div>
${body}
<script>
${TIMEZONE_JS}</script>
</body>
</html>
`;
}

/** Render the interactive exchange cards (escaped; no scripts). */
function turnsHtml(data: ReportData): string {
  if (data.turns.length === 0) return '<p><em>No prompts recorded.</em></p>';
  // On the combined team report, attribute each card to its author.
  const showAuthor = data.scope === null && data.contributors.length > 1;
  const nameBySlug = new Map(data.contributors.map((c) => [c.slug, c.name]));
  const out: string[] = [];
  for (const turn of data.turns) {
    const fileCount = turn.codeChanges.length;
    const lineCount = turn.codeChanges.reduce((n, c) => n + (c.diffLines ?? 0), 0);
    // Only surface the edit count when there were edits; "no edits" is noise in
    // a tight summary row.
    const stat =
      fileCount === 0
        ? ''
        : `edited ${fileCount} file(s)${lineCount ? `, ~${lineCount} line(s)` : ''}`;
    const authorName = showAuthor
      ? (nameBySlug.get(turn.actorSlug) ?? turn.actorSlug)
      : '';
    const authorBadge = authorName
      ? `<span class="badge badge--author" data-author="${escapeHtml(turn.actorSlug)}">${escapeHtml(authorName)}</span>`
      : '';

    out.push('<details class="turn">');
    out.push(
      '<summary>' +
        `<span class="prompt-text">${escapeHtml(firstLine(turn.prompt.text))}</span>` +
        '<span class="meta">' +
        '<span class="meta-top">' +
        authorBadge +
        `<span class="badge badge--${escapeHtml(turn.tool)}">${escapeHtml(toolLabel(turn.tool))}</span>` +
        `<span class="time">${timeTag(turn.prompt.timestamp)}</span>` +
        '</span>' +
        (stat ? `<span class="stat">${escapeHtml(stat)}</span>` : '') +
        '</span>' +
        '</summary>',
    );
    out.push('<div class="turn-body">');

    // Show the full prompt only when it has more than the one line in the summary,
    // marked distinctly so the student's words are clear from the AI's reply.
    if (turn.prompt.text.trim() !== firstLine(turn.prompt.text)) {
      out.push(
        `<div class="prompt-block"><span class="role-tag">Prompt</span>` +
          `<div class="ai-text">${renderRichText(turn.prompt.text)}</div></div>`,
      );
    }
    // The card already means "this prompt → its reply", so the reply needs no
    // label; multiple replies in one turn are separated by a thin divider.
    turn.aiOutputs.forEach((ai, i) => {
      if (i > 0) out.push('<hr class="ai-sep">');
      out.push(`<div class="ai-text">${renderRichText(ai.text)}</div>`);
    });
    // Decisions the student made mid-exchange, in their own labelled block so a
    // reviewer can't mistake them for a prompt or an AI reply.
    for (const decision of turn.decisions) {
      out.push(
        '<div class="decision">' +
          '<span class="role-tag decision-tag">🔀 Decision</span>' +
          `<div class="ai-text">${renderRichText(decision.text)}</div>` +
          '</div>',
      );
    }
    for (const code of turn.codeChanges) {
      const stat2 = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
      const fileLink =
        `<a class="file-link" href="${escapeHtml(fileHref(code.path))}" ` +
        'target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
        `${escapeHtml(code.path)}</a>`;
      if (code.diff) {
        // A diff was captured — show it in an expandable card.
        out.push('<details class="code">');
        out.push(`<summary>${fileLink}${escapeHtml(stat2)}</summary>`);
        out.push(diffHtml(code.diff));
        out.push('</details>');
      } else {
        // No inline diff (e.g. a file snapshot with no suggested code, or a Codex
        // shell edit). Render a plain file row — not an expander that opens to
        // nothing. The file link still works.
        out.push(`<div class="code code-file">${fileLink}${escapeHtml(stat2)}</div>`);
      }
    }

    out.push('</div>'); // end .turn-body

    // Full-width footer that collapses the card — a direct child of the card so
    // it spans edge to edge. Inline handler keeps the file self-contained
    // (degrades to a no-op if JS is disabled; the summary still toggles).
    out.push(
      '<button type="button" class="turn-close" ' +
        'onclick="this.closest(\'details.turn\').open=false">▲ Close</button>',
    );

    out.push('</details>');
  }
  return out.join('\n');
}

/**
 * Render a diff GitHub-style: each line is a full-width block row with a faint
 * add/del tint and a +/- gutter, and the code itself is syntax-highlighted (the
 * add/del state lives in the tint + gutter, not the text color). Rows are
 * concatenated with no `\n` so there are no blank gaps between them.
 */
function diffHtml(diff: string): string {
  const rows = diff.split('\n').map((raw) => {
    let cls = 'ctx';
    let mark = ' ';
    let code = raw.replace(/^ /, ''); // drop a unified-diff context space
    if (/^\+/.test(raw)) {
      cls = 'add';
      mark = '+';
      code = raw.replace(/^\+ ?/, '');
    } else if (/^-/.test(raw)) {
      cls = 'del';
      mark = '-';
      code = raw.replace(/^- ?/, '');
    }
    return (
      `<span class="dline ${cls}"><span class="dmark">${mark}</span>` +
      `${highlightCode(code) || '&nbsp;'}</span>`
    );
  });
  return `<pre class="diff">${rows.join('')}</pre>`;
}
