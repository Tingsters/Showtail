import REPORT_CSS from '../../../assets/report/report.css' with { type: 'text' };
import TIMEZONE_JS from '../../../assets/report/timezone.js' with { type: 'text' };
import CONTROLS_JS from '../../../assets/report/report-controls.js' with { type: 'text' };
import type { Event, ReportData, Turn } from '../../types.ts';
import { escapeHtml, firstLine } from '../html.ts';
import { highlightCode } from '../highlight.ts';
import {
  formatDuration,
  longTurnThreshold,
  modelLabel,
  nameBySlugMap,
  shouldShowAuthor,
  summarizeToolRun,
  toolLabel,
  type TurnItem,
  turnModels,
  turnSegments,
  turnSignals,
} from './data.ts';
import { pluralS } from '../text.ts';
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
<div class="st-tzbar"><span class="st-tzlabel">Times shown in <select id="st-tz" aria-label="Display timezone"></select></span></div>
${body}
<script>
${TIMEZONE_JS}
${CONTROLS_JS}</script>
</body>
</html>
`;
}

/** How much of a prompt the collapsed row shows before it is cut. */
const PROMPT_PREVIEW_CHARS = 180;

/** Context a row needs that depends on the rest of the report, not just the turn. */
interface RowContext {
  showAuthor: boolean;
  nameBySlug: Map<string, string>;
  /** Durations at or above this are worth flagging; undefined = flag none. */
  longTurnMs?: number;
}

/**
 * The collapsed `<summary>` for a turn — a triage row, not a stat line.
 *
 * Its reader is an educator scanning more turns than they can read, so it
 * carries the student's own words, what those words produced, and *sparse*
 * markers for the turns worth opening. Everything that would appear on every
 * row (duration, tool counts, tokens, an unchanged tool/model badge) lives in
 * the detail strip inside instead: a marker only guides the eye while most rows
 * have none.
 */
function renderTurnSummary(turn: Turn, ctx: RowContext): string {
  const fileCount = turn.codeChanges.length;
  const lineCount = turn.codeChanges.reduce((n, c) => n + (c.diffLines ?? 0), 0);
  const parts: string[] = [];
  // What the exchange produced — the outcome, and the one fact worth a number.
  if (fileCount > 0) {
    const files = `${fileCount} file${pluralS(fileCount)}`;
    const lines = lineCount ? ` · ~${lineCount} line${pluralS(lineCount)}` : '';
    parts.push(`<span class="stat">${escapeHtml(files + lines)}</span>`);
  }
  parts.push(...renderSignals(turn, ctx.longTurnMs));

  const authorName = ctx.showAuthor
    ? (ctx.nameBySlug.get(turn.actorSlug) ?? turn.actorSlug)
    : '';
  const authorBadge = authorName
    ? `<span class="badge badge--author" data-author="${escapeHtml(turn.actorSlug)}">${escapeHtml(authorName)}</span>`
    : '';
  // Tool and model repeat identically on every row of a single-tool session, so
  // a badge is only worth showing where it *changes* — which turns a switch into
  // a real event. Both badges are always emitted and the repeats merely marked,
  // because the reader can re-sort the rows: which row begins a run is a
  // property of the order on screen, not of the order we rendered in, so the
  // controls script recomputes these marks after every reorder.
  const toolBadge = `<span class="badge badge--${escapeHtml(turn.tool)}">${escapeHtml(toolLabel(turn.tool))}</span>`;
  const models = turnModels(turn);
  const modelBadges = models
    .map((m) => `<span class="badge badge--model">${escapeHtml(modelLabel(m))}</span>`)
    .join('');
  return (
    '<summary>' +
    // Floated first so the prompt's later lines wrap beneath it (see report.css).
    '<span class="meta">' +
    '<span class="meta-top">' +
    authorBadge +
    toolBadge +
    modelBadges +
    `<span class="time">${timeTag(turn.prompt.timestamp)}</span>` +
    '</span>' +
    (parts.length > 0 ? `<span class="stats">${parts.join('')}</span>` : '') +
    '</span>' +
    `<span class="prompt-text">${escapeHtml(truncate(turn.prompt.text.trim(), PROMPT_PREVIEW_CHARS))}</span>` +
    '</summary>'
  );
}

/**
 * The row's markers: the student's judgement and the friction they worked
 * through, each rendered only when it happened. Kept as short words rather than
 * bare glyphs — they are rare enough to afford the width, and a professor
 * should not have to learn a symbol key.
 */
function renderSignals(turn: Turn, longTurnMs?: number): string[] {
  const s = turnSignals(turn);
  const out: string[] = [];
  const add = (cls: string, text: string, title: string) =>
    out.push(
      `<span class="signal signal--${cls}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`,
    );
  if (s.decisions > 0) {
    add(
      'decision',
      s.decisions > 1 ? `🔀 ${s.decisions} decisions` : '🔀 decision',
      'The student chose between options the AI offered',
    );
  }
  if (s.plansRevised > 0) {
    add(
      'revised',
      s.plansRevised > 1 ? `↩ ${s.plansRevised} plans revised` : '↩ plan revised',
      'The student sent a plan back for changes rather than approving it',
    );
  }
  if (s.plansProposed > 0) {
    add(
      'plan',
      s.plansProposed > 1 ? `📋 ${s.plansProposed} plans` : '📋 plan',
      'The AI proposed a plan in plan mode',
    );
  }
  if (s.failedTools > 0) {
    add(
      'failed',
      `⚠ ${s.failedTools} failed`,
      'Commands that failed and were worked through',
    );
  }
  const ms = turn.recap?.durationMs;
  if (ms !== undefined && longTurnMs !== undefined && ms >= longTurnMs) {
    add('long', `⏱ ${formatDuration(ms)}`, 'One of the longest turns in this session');
  }
  return out;
}

/**
 * The dim strip at the top of an opened turn: everything the collapsed row
 * deliberately left out. Nothing here is triage signal, but all of it is worth
 * having once you have decided to read this turn — including the per-turn token
 * usage and git branch, which are captured but were previously never displayed.
 */
function renderTurnDetail(turn: Turn): string {
  const bits: string[] = [toolLabel(turn.tool)];
  for (const m of turnModels(turn)) bits.push(modelLabel(m));
  const recap = turn.recap;
  if (recap?.durationMs) bits.push(formatDuration(recap.durationMs));
  if (turn.toolCalls.length > 0) {
    const { total, byTool, failed } = summarizeToolRun(turn.toolCalls);
    const breakdown = byTool.map((t) => `${t.count} ${t.name}`).join(', ');
    bits.push(
      `${total} tool call${pluralS(total)}${breakdown ? ` (${breakdown})` : ''}` +
        (failed > 0 ? ` · ${failed} failed` : ''),
    );
  }
  const tokens =
    (recap?.inputTokens ?? 0) +
    (recap?.outputTokens ?? 0) +
    (recap?.cacheReadTokens ?? 0) +
    (recap?.cacheCreationTokens ?? 0);
  if (tokens > 0) bits.push(`${formatTokens(tokens)} tokens`);
  if (recap?.gitBranch) bits.push(recap.gitBranch);
  return `<div class="turn-detail">${escapeHtml(bits.join(' · '))}</div>`;
}

/** Token counts compactly: `14.2k` past a thousand, plain below. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * A run of consecutive tool calls as one quiet group.
 *
 * The mechanism is the least important thing in a turn, so it collapses to a
 * single line the way the AI pill does — a real session can fire well over a
 * hundred calls in one turn, and rendering each as its own card buried
 * everything the student actually did. Each call inside is a cheap row: name,
 * invocation, and its output only if there was any.
 */
function renderToolRun(events: Event[]): string {
  // A lone call needs no group around it — a "1 tool call" header over a single
  // row is pure chrome. It stays clickable: a run break always has a non-tool
  // item in between, so a lone row can never sit beside another clickable row.
  if (events.length === 1) return renderToolRow(events[0]!, true);
  const { total, byTool, failed } = summarizeToolRun(events);
  const breakdown = byTool.map((t) => `${t.count} ${escapeHtml(t.name)}`).join(' · ');
  const failedBadge =
    failed > 0 ? ` <span class="tool-run-failed">⚠ ${failed} failed</span>` : '';
  // The group is the *only* click target in the run. Its rows are plain, so
  // opening it reveals every command and its output in one go rather than
  // handing back a stack of further disclosures to click through.
  const rows = events.map((e) => renderToolRow(e, false)).join('\n');
  return [
    `<details class="tools${failed > 0 ? ' has-error' : ''}">`,
    '<summary>' +
      `<span class="role-tag tool-run-tag">🛠 ${total} tool call${pluralS(total)}</span>` +
      (breakdown ? ` <span class="tool-run-breakdown">${breakdown}</span>` : '') +
      failedBadge +
      '</summary>',
    `<div class="tool-run-body">\n${rows}\n</div>`,
    '</details>',
  ].join('\n');
}

/**
 * One call: its name, the invocation, and whatever it printed.
 *
 * `clickable` is true only for a call standing on its own, where the row itself
 * must be the disclosure. Inside a group it is false — the group already is the
 * click target, and nesting disclosures inside it meant reaching one command's
 * output took two clicks past a stack of identical affordances. A row with no
 * output is always plain: an expander that opens to nothing is worse than none.
 */
function renderToolRow(event: Event, clickable: boolean): string {
  const name = escapeHtml(event.toolName ?? 'Tool');
  const cls = event.isError ? 'tool-row is-error' : 'tool-row';
  // `text` is the rendered invocation plus, when captured, a fenced result block.
  // Split them so the invocation leads and the output follows.
  const text = event.text;
  const split = text.indexOf('\n\n');
  const head = (split === -1 ? text : text.slice(0, split)).trim();
  const body = split === -1 ? '' : text.slice(split + 2).trim();
  const label = `<span class="tool-row-name">${name}</span>`;
  const invocation = `<span class="tool-row-cmd">${escapeHtml(truncate(head, 160))}</span>`;
  if (!body) {
    return `<div class="${cls}">${label}${invocation}</div>`;
  }
  const output = `<div class="ai-text tool-row-out">${renderRichText(body)}</div>`;
  if (!clickable) {
    return `<div class="${cls}">${label}${invocation}${output}</div>`;
  }
  return [
    `<details class="${cls}">`,
    `<summary>${label}${invocation}</summary>`,
    output,
    '</details>',
  ].join('\n');
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
  if (item.kind === 'tool_call') {
    // A lone tool call outside a run; runs go through `renderToolRun`.
    return renderToolRow(item.event, true);
  }
  const code = item.change;
  const stat = code.diffLines
    ? ` (~${code.diffLines} line${pluralS(code.diffLines)})`
    : '';
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
 * The turn's AI narration: quiet railed prose, with no header of its own.
 *
 * It used to sit under a disclosure whose summary was an icon, a Show/Hide verb,
 * a message count and a preview — but the preview *was* the body's first line,
 * and the median run is ~107 characters against a 90-character preview, so the
 * whole row existed to hide about 17 characters. Nothing announces the narration
 * now because nothing needs to: every other block in a turn body is marked (the
 * prompt is tinted and labelled, decisions amber, plans indigo, tool calls dim
 * monospace, the recap italic), so unlabelled prose can only be the AI talking.
 * The rail carries that signal from the margin, at no cost in height.
 *
 * The long tail — the top few percent run 15-40 lines — is clamped by
 * `report-controls.js` with a "Show more" *below* the text, so a control appears
 * only where it is needed and never above a message. That clamp is applied at
 * runtime, so a reader without JavaScript sees every message in full.
 */
function renderAiBlock(events: Event[]): string {
  const bodies = events
    .map((e) => `<div class="ai-text">${renderRichText(e.text)}</div>`)
    .join('\n');
  return `<div class="ai-block">\n${bodies}\n</div>`;
}

/** Trim to `max` characters on a word boundary, adding an ellipsis when cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/**
 * The sticky controls bar above the exchanges. Rendered `hidden`; report-controls.js
 * reveals it on load, so a no-JS reader never sees non-functional controls (the
 * report stays fully readable, turns expand natively, order stays chronological).
 * Three controls: expand/collapse-all, the AI show/hide switch (omitted in `off`
 * mode), and the Time|Session sort toggle with a direction caret.
 */
function renderToolbar(mode: AiMode): string {
  const aiSwitch =
    mode === 'off'
      ? ''
      : '<div class="st-exbar-grp"><label class="st-switch" title="Show or hide every AI message">' +
        // Checked by default: narration is now shown, and the switch hides it
        // rather than collapsing it.
        '<input type="checkbox" id="st-ai" checked>' +
        '<span class="st-switch-ui"></span>' +
        '<span class="st-switch-label">AI messages</span></label></div>';
  return [
    '<div class="st-exbar" hidden>',
    '<div class="st-exbar-grp">',
    '<button type="button" class="st-btn" id="st-expand" aria-pressed="false">' +
      '<span class="st-btn-icon">⤢</span> <span class="st-btn-label">Expand all</span></button>',
    '</div>',
    aiSwitch,
    '<div class="st-exbar-grp st-exbar-end">',
    '<span class="st-seg-label">Sort</span>',
    '<div class="st-seg" id="st-sort" role="group" aria-label="Sort exchanges">',
    '<button type="button" class="st-seg-btn is-active" data-mode="time" data-dir="asc">' +
      'Time <span class="st-caret">▲</span></button>',
    '<button type="button" class="st-seg-btn" data-mode="session" data-dir="asc">' +
      'Session <span class="st-caret">▲</span></button>',
    '</div>',
    '</div>',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Render the interactive exchange cards (escaped; no scripts). */
function turnsHtml(data: ReportData, mode: AiMode): string {
  if (data.turns.length === 0) return '<p><em>No prompts recorded.</em></p>';
  // On the combined team report, attribute each card to its author.
  const showAuthor = shouldShowAuthor(data);
  const nameBySlug = nameBySlugMap(data.contributors);
  // What counts as a "long" turn is relative to this report: sessions range from
  // seconds to the best part of an hour, so a fixed cutoff would either mark
  // half the rows or none.
  const longTurnMs = longTurnThreshold(data.turns);
  // `data-ai-mode` tells the controls script whether to clamp long narration:
  // `full` means the reader asked to see all of it, so it is left alone.
  const out: string[] = [
    renderToolbar(mode),
    `<div id="st-exchanges" data-ai-mode="${escapeHtml(mode)}">`,
  ];
  data.turns.forEach((turn, i) => {
    const segments = turnSegments(turn);
    // Which rows repeat the row above them, for the default (chronological)
    // order. The controls script recomputes these the moment the reader sorts,
    // since "repeats the previous row" depends on the order on screen; these
    // classes are the correct answer for the order a no-JS reader sees.
    const previous = data.turns[i - 1];
    const toolLabelText = toolLabel(turn.tool);
    const modelsText = turnModels(turn).map(modelLabel).join(', ');
    const repeat: string[] = [];
    if (previous && previous.tool === turn.tool) repeat.push('is-repeat-tool');
    if (previous && turnModels(previous).map(modelLabel).join(', ') === modelsText) {
      repeat.push('is-repeat-model');
    }
    // data-* drive the toolbar's sort (by prompt time, or grouped by session)
    // and the badge-run recompute.
    out.push(
      `<details class="turn${repeat.length ? ' ' + repeat.join(' ') : ''}" ` +
        `data-ts="${escapeHtml(turn.prompt.timestamp)}" ` +
        `data-session="${escapeHtml(turn.sessionId)}" ` +
        `data-tool="${escapeHtml(turn.tool)}" ` +
        `data-tool-label="${escapeHtml(toolLabelText)}" ` +
        `data-models="${escapeHtml(modelsText)}">`,
    );
    out.push(renderTurnSummary(turn, { showAuthor, nameBySlug, longTurnMs }));
    out.push('<div class="turn-body">');
    out.push(renderTurnDetail(turn));

    // Show the full prompt only when the row's preview cut it short, marked
    // distinctly so the student's words are clear from the AI's reply.
    const prompt = turn.prompt.text.trim();
    if (prompt !== truncate(prompt, PROMPT_PREVIEW_CHARS)) {
      out.push(
        `<div class="prompt-block"><span class="role-tag">Prompt</span>` +
          `<div class="ai-text">${renderRichText(turn.prompt.text)}</div></div>`,
      );
    }
    if (turn.recap?.text) {
      out.push(
        `<div class="recap"><span class="role-tag">✻ Recap</span>` +
          `<div class="ai-text">${renderRichText(turn.recap.text)}</div></div>`,
      );
    }
    // One chronological stream: work items inline, each run of AI messages or
    // tool calls collapsed in the position it occurred. `--ai off` drops the AI
    // pills, leaving only the student's work in order.
    for (const seg of segments) {
      if (seg.kind === 'work') out.push(renderTimelineItem(seg.item));
      else if (seg.kind === 'tools') out.push(renderToolRun(seg.events));
      else if (mode !== 'off') out.push(renderAiBlock(seg.events));
    }

    out.push('</div>'); // end .turn-body

    // Full-width footer that collapses the card — a direct child of the card so
    // it spans edge to edge. Inline handler keeps the file self-contained
    // (degrades to a no-op if JS is disabled; the summary still toggles).
    // Collapsing also scrolls the row back into view: by the time you have read
    // down to this button the prompt it belongs to is far above the viewport,
    // and closing without this drops you somewhere unrelated with no idea which
    // exchange you were on. `nearest` only scrolls when the row is off-screen,
    // so closing a short card still moves nothing.
    out.push(
      '<button type="button" class="turn-close" ' +
        "onclick=\"var d=this.closest('details.turn');d.open=false;" +
        "d.scrollIntoView({block:'nearest'})\">▲ Close</button>",
    );

    out.push('</details>');
  });
  out.push('</div>'); // #st-exchanges
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
