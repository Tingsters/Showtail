import REPORT_CSS from '../../../assets/report/report.css' with { type: 'text' };
import TIMEZONE_JS from '../../../assets/report/timezone.js' with { type: 'text' };
import CONTROLS_JS from '../../../assets/report/report-controls.js' with { type: 'text' };
import type { Event, ReportData, Turn } from '../../types.ts';
import { escapeHtml, firstLine } from '../html.ts';
import { highlightCode } from '../highlight.ts';
import {
  modelLabel,
  nameBySlugMap,
  shouldShowAuthor,
  toolLabel,
  type TurnItem,
  turnModels,
  turnView,
} from './data.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG, splitPlanText } from '../plans.ts';
import {
  type AiMode,
  buildMarkdown,
  fileHref,
  planHref,
  type ReportRenderOptions,
  resolveAiMode,
  TURNS_PLACEHOLDER,
} from './markdown.ts';
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
export function renderHtml(data: ReportData, opts?: ReportRenderOptions): string {
  const mode = resolveAiMode(opts);
  const base = `Showtail Report — ${data.displayName}`;
  const title = data.scope ? `${base} — ${data.scope.name}` : base;
  const body = markdownToHtml(buildMarkdown(data, true, opts))
    // Swap the timestamp tokens emitted in HTML mode for real <time> elements
    // FIRST, before splicing in the turn cards. The cards embed <time> directly
    // (they carry no tokens), and their escaped prompt/AI text can itself contain
    // the sentinel — Showtail captures its own sessions — so running this global
    // regex after the splice would match and corrupt that content.
    .replace(TIME_TOKEN, (_m, iso: string) => timeTag(iso))
    .replace(`<p>${TURNS_PLACEHOLDER}</p>`, turnsHtml(data, mode));
  // A "Show AI process" checkbox lives alongside the timezone picker; it flips
  // every per-turn AI disclosure open at once (see report-controls.js). Omitted
  // in `off` mode, where there's no AI layer to reveal. Its checked state seeds
  // the default the script applies when no saved preference exists.
  const aiToggle =
    mode === 'off'
      ? ''
      : `<label class="st-aitoggle"><input type="checkbox" id="st-ai"${mode === 'full' ? ' checked' : ''}> Show AI process</label>`;
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
<div class="st-tzbar"><span class="st-tzlabel">Times shown in <select id="st-tz" aria-label="Display timezone"></select></span>${aiToggle}</div>
${body}
<script>
${TIMEZONE_JS}
${CONTROLS_JS}</script>
</body>
</html>
`;
}

/** The collapsed `<summary>` for a turn: prompt line, author/tool badges, time, stat. */
function renderTurnSummary(
  turn: Turn,
  showAuthor: boolean,
  nameBySlug: Map<string, string>,
): string {
  const fileCount = turn.codeChanges.length;
  const lineCount = turn.codeChanges.reduce((n, c) => n + (c.diffLines ?? 0), 0);
  // Surface what happened in this exchange as a compact stat under the date, so
  // a reviewer can see edits and decisions without expanding the card. Each part
  // appears only when it occurred; edits and decisions coexist (joined by " · ").
  const statParts: string[] = [];
  if (fileCount > 0) {
    statParts.push(`${fileCount} file(s)${lineCount ? `, ~${lineCount} line(s)` : ''}`);
  }
  if (turn.decisions.length > 0) statParts.push(`${turn.decisions.length} decision(s)`);
  if (turn.plans.length > 0) statParts.push(`${turn.plans.length} plan(s)`);
  const stat = statParts.join(' · ');
  const authorName = showAuthor ? (nameBySlug.get(turn.actorSlug) ?? turn.actorSlug) : '';
  const authorBadge = authorName
    ? `<span class="badge badge--author" data-author="${escapeHtml(turn.actorSlug)}">${escapeHtml(authorName)}</span>`
    : '';
  // The model(s) this exchange used, as a secondary (outlined) badge next to the
  // tool badge. Normally one; omitted entirely when no model was captured.
  const modelBadges = turnModels(turn)
    .map((m) => `<span class="badge badge--model">${escapeHtml(modelLabel(m))}</span>`)
    .join('');
  return (
    '<summary>' +
    `<span class="prompt-text">${escapeHtml(firstLine(turn.prompt.text))}</span>` +
    '<span class="meta">' +
    '<span class="meta-top">' +
    authorBadge +
    `<span class="badge badge--${escapeHtml(turn.tool)}">${escapeHtml(toolLabel(turn.tool))}</span>` +
    modelBadges +
    `<span class="time">${timeTag(turn.prompt.timestamp)}</span>` +
    '</span>' +
    (stat ? `<span class="stat">${escapeHtml(stat)}</span>` : '') +
    '</span>' +
    '</summary>'
  );
}

/** One interleaved item (AI reply, decision, or code change) inside a turn body. */
function renderTimelineItem(item: TurnItem): string {
  if (item.kind === 'ai') {
    return `<div class="ai-text">${renderRichText(item.event.text)}</div>`;
  }
  if (item.kind === 'decision') {
    // The student's mid-exchange choice, labelled so it's never mistaken for a
    // prompt or an AI reply.
    return (
      '<div class="decision">' +
      '<span class="role-tag decision-tag">🔀 Decision</span>' +
      `<div class="ai-text">${renderRichText(item.event.text)}</div>` +
      '</div>'
    );
  }
  if (item.kind === 'plan') {
    // A plan the AI proposed — collapsible (plans are long), with its approval
    // status (and, when sent back, the revision feedback) on the summary so both
    // read before expanding. The body holds just the plan. A plan from a tool with
    // no approval flow (Codex) carries neither tag and shows no badge.
    const approved = item.event.tags?.includes(PLAN_APPROVED_TAG);
    const revised = item.event.tags?.includes(PLAN_REVISED_TAG);
    const { feedback, plan } = splitPlanText(item.event.text);
    const badge = approved
      ? ' <span class="plan-badge approved">✅ Approved</span>'
      : revised
        ? ' <span class="plan-badge revised">↩ Revised</span>'
        : '';
    const fb = feedback
      ? ` <span class="plan-feedback">“${escapeHtml(feedback)}”</span>`
      : '';
    // A link to the saved plan file, when the plan was materialized. The
    // stopPropagation keeps a click on the link from toggling the <details>.
    const planLink = item.event.planPath
      ? `<a class="file-link plan-file-link" href="${escapeHtml(planHref(item.event.planPath))}" ` +
        'target="_blank" rel="noopener" onclick="event.stopPropagation()">view plan file</a>'
      : '';
    return [
      '<details class="plan">',
      `<summary><span class="role-tag plan-tag">📋 Plan</span>${badge}${fb}` +
        (planLink ? ` ${planLink}` : '') +
        '</summary>',
      `<div class="ai-text">${renderRichText(plan)}</div>`,
      '</details>',
    ].join('\n');
  }
  const code = item.change;
  const stat = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
  const fileLink =
    `<a class="file-link" href="${escapeHtml(fileHref(code.linkPath ?? code.path))}" ` +
    'target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
    `${escapeHtml(code.path)}</a>`;
  if (code.diff) {
    // A diff was captured — show it in an expandable card. The pieces join with
    // newlines to match the surrounding card markup exactly.
    return [
      '<details class="code">',
      `<summary>${fileLink}${escapeHtml(stat)}</summary>`,
      diffHtml(code.diff),
      '</details>',
    ].join('\n');
  }
  // No inline diff (e.g. a file snapshot with no suggested code, or a Codex shell
  // edit). Render a plain file row — not an expander that opens to nothing.
  return `<div class="code code-file">${fileLink}${escapeHtml(stat)}</div>`;
}

/**
 * The turn's sidelined AI narration, as one collapsed disclosure. The summary
 * carries the message count and a short preview of the first message, so a reader
 * knows what's inside — and how much — before deciding to expand. `open` reflects
 * the report's default AI mode; the header toggle flips every such group at once.
 */
function renderAiProcess(events: Event[], open: boolean): string {
  const preview = escapeHtml(truncate(firstLine(events[0]!.text), 90));
  const bodies = events
    .map((e) => `<div class="ai-text">${renderRichText(e.text)}</div>`)
    .join('\n');
  return [
    `<details class="ai-process"${open ? ' open' : ''}>`,
    `<summary><span class="ai-process-tag">🤖 ${events.length} AI message${events.length === 1 ? '' : 's'}</span>` +
      (preview ? ` <span class="ai-preview">${preview}</span>` : '') +
      '</summary>',
    bodies,
    '</details>',
  ].join('\n');
}

/** Trim to `max` characters on a word boundary, adding an ellipsis when cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/** Render the interactive exchange cards (escaped; no scripts). */
function turnsHtml(data: ReportData, mode: AiMode): string {
  if (data.turns.length === 0) return '<p><em>No prompts recorded.</em></p>';
  // On the combined team report, attribute each card to its author.
  const showAuthor = shouldShowAuthor(data);
  const nameBySlug = nameBySlugMap(data.contributors);
  const out: string[] = [];
  for (const turn of data.turns) {
    const { flow, aiProcess } = turnView(turn);
    out.push('<details class="turn">');
    out.push(renderTurnSummary(turn, showAuthor, nameBySlug));
    out.push('<div class="turn-body">');

    // Show the full prompt only when it has more than the one line in the summary,
    // marked distinctly so the student's words are clear from the AI's reply.
    if (turn.prompt.text.trim() !== firstLine(turn.prompt.text)) {
      out.push(
        `<div class="prompt-block"><span class="role-tag">Prompt</span>` +
          `<div class="ai-text">${renderRichText(turn.prompt.text)}</div></div>`,
      );
    }
    // The work, in order: code changes, decisions, plans, and the AI text that
    // introduces a change (its "why"). In `off` mode even that introducing text
    // is dropped, leaving only the student's prompt/decisions and the changes.
    const shown = mode === 'off' ? flow.filter((i) => i.kind !== 'ai') : flow;
    for (const item of shown) out.push(renderTimelineItem(item));

    // The AI's remaining narration, subordinated to one collapsed disclosure so
    // it never fronts the student's work. Omitted in `off` mode.
    if (mode !== 'off' && aiProcess.length > 0) {
      out.push(renderAiProcess(aiProcess, mode === 'full'));
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
