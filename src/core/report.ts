import type {
  Artifact,
  Event,
  JournalEntry,
  ReportData,
  Tool,
  ToolBlock,
  ToolUsage,
  Turn,
} from '../types.ts';
import { TOOL_LABELS } from '../types.ts';
import { readArtifacts } from './artifacts.ts';
import { readAllEventsWithSession } from './events.ts';
import { highlightCode } from './highlight.ts';
import { readObject } from './objects.ts';
import { readConfig, readJournal, readSessions, type ShowtailPaths } from './storage.ts';

/** The tool an event flowed through (defaults to "cli" for older/manual events). */
function toolOf(event: Event): Tool {
  return (event.tool as Tool) ?? 'cli';
}

function toolLabel(tool: Tool): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** One event paired with the id of the session it belongs to. */
type EventWithSession = { event: Event; sessionId: string };

/** Build the structured report data from everything recorded in the project. */
export function buildReportData(paths: ShowtailPaths): ReportData {
  const config = readConfig(paths);
  const sessions = readSessions(paths);
  const artifacts = readArtifacts(paths);
  const withSession = readAllEventsWithSession(paths);
  const events = withSession.map((x) => x.event);

  const tools = buildToolUsage(events);
  const sorted = sortByTime(events);

  return {
    project: config.project ?? null,
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: sessions.length,
      events: events.length,
      artifacts: artifacts.length,
    },
    tools,
    toolTimeline: buildToolBlocks(sorted),
    turns: buildTurns(withSession, artifacts, paths),
    redactionCount: countRedactions(paths),
    authorship: buildAuthorshipStatement(config.project, tools),
  };
}

function sortByTime(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Total number of secrets/PII Showtail scrubbed across the whole trail. */
function countRedactions(paths: ShowtailPaths): number {
  let total = 0;
  for (const e of readJournal(paths)) total += e.redacted ?? 0;
  return total;
}

/**
 * Group the event stream into "turns": each prompt plus the AI text outputs and
 * code changes it produced. A turn is linked by `turnId` where present, and by
 * timestamp adjacency (within the same session) otherwise, so older trails still
 * group sensibly.
 */
export function buildTurns(
  withSession: EventWithSession[],
  artifacts: Artifact[],
  paths: ShowtailPaths,
): Turn[] {
  const prompts = withSession
    .filter((x) => x.event.type === 'prompt')
    .sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));

  const turns: Turn[] = prompts.map(({ event }) => ({
    prompt: event,
    aiOutputs: [],
    codeChanges: [],
    tool: toolOf(event),
  }));
  const turnByPrompt = new Map<string, Turn>();
  prompts.forEach((p, i) => turnByPrompt.set(p.event.id, turns[i]!));

  // The latest prompt at-or-before `ts` in the same session (adjacency fallback).
  const fallback = (ts: string, session: string): Turn | undefined => {
    let best: Turn | undefined;
    let bestTs = '';
    for (const p of prompts) {
      if (p.sessionId !== session) continue;
      if (p.event.timestamp <= ts && p.event.timestamp >= bestTs) {
        best = turnByPrompt.get(p.event.id);
        bestTs = p.event.timestamp;
      }
    }
    return best;
  };

  for (const { event, sessionId } of withSession) {
    if (event.type !== 'ai_output') continue;
    const turn =
      (event.turnId ? turnByPrompt.get(event.turnId) : undefined) ??
      fallback(event.timestamp, sessionId);
    if (turn) turn.aiOutputs.push(event);
  }

  for (const a of artifacts) {
    const turn =
      (a.turnId ? turnByPrompt.get(a.turnId) : undefined) ??
      fallback(a.timestamp, a.sessionId ?? '');
    if (!turn) continue;
    const diff = a.diffHash ? (readObject(paths, a.diffHash) ?? undefined) : undefined;
    turn.codeChanges.push({
      path: a.path,
      diff,
      diffLines: a.diffLines,
      tool: a.tool as Tool | undefined,
      timestamp: a.timestamp,
    });
  }

  return turns;
}

/** Count events per tool, busiest first. */
function buildToolUsage(events: Event[]): ToolUsage[] {
  const counts = new Map<Tool, number>();
  for (const e of events) {
    const t = toolOf(e);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, events: count }))
    .sort((a, b) => b.events - a.events);
}

/**
 * Collapse a time-ordered event stream into contiguous tool blocks. Each
 * boundary between blocks is a moment the student switched tools — which is
 * exactly what a professor needs to follow.
 */
export function buildToolBlocks(sortedEvents: Event[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  for (const e of sortedEvents) {
    const tool = toolOf(e);
    const last = blocks[blocks.length - 1];
    if (last && last.tool === tool) {
      last.to = e.timestamp;
      last.count += 1;
    } else {
      blocks.push({ tool, from: e.timestamp, to: e.timestamp, count: 1 });
    }
  }
  return blocks;
}

function buildAuthorshipStatement(
  project: string | undefined,
  tools: ToolUsage[],
): string {
  const name = project ? `"${project}"` : 'this project';
  const toolList =
    tools.length > 0
      ? ' I worked through ' +
        joinAnd(tools.map((t) => toolLabel(t.tool))) +
        ', and this trail records each.'
      : '';
  return (
    `I recorded this trail while working on ${name}. It shows the prompts I used ` +
    `and the files I built along the way.${toolList} The work and understanding ` +
    `represented here are my own.`
  );
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** A unique token swapped for the interactive turns HTML after Markdown→HTML. */
const TURNS_PLACEHOLDER = 'SHOWTAIL_TURNS_PLACEHOLDER';

/**
 * Render a report as student- and educator-friendly Markdown. When
 * `turnsPlaceholder` is set, the exchanges are emitted as a single placeholder
 * line (swapped for interactive HTML cards by {@link renderHtml}); otherwise the
 * exchanges render as readable Markdown for the canonical text export.
 */
function buildMarkdown(data: ReportData, turnsPlaceholder = false): string {
  const lines: string[] = [];
  const title = data.project ? `Showtail Report — ${data.project}` : 'Showtail Report';

  // In HTML mode, timestamps are emitted as tokens that {@link renderHtml} swaps
  // for interactive <time> elements; the canonical Markdown export uses static UTC.
  const fmt = turnsPlaceholder ? timeToken : staticUtc;

  lines.push(`# ${title}`, '');
  lines.push(`_Generated ${fmt(data.generatedAt)}_`, '');
  lines.push(
    `**Summary:** ${data.summary.sessions} session(s), ` +
      `${data.summary.events} event(s), ${data.summary.artifacts} artifact record(s).`,
    '',
  );
  if (data.redactionCount > 0) {
    lines.push(
      `_Showtail removed ${data.redactionCount} secret(s)/personal detail(s) ` +
        `before saving._`,
      '',
    );
  }

  // Tools used — up front so a reviewer can see, at a glance, which tools the
  // student used and when they switched between them.
  lines.push('## Tools used', '');
  if (data.tools.length === 0) {
    lines.push('_No tool activity recorded._', '');
  } else {
    for (const t of data.tools) {
      lines.push(`- **${toolLabel(t.tool)}** — ${t.events} event(s)`);
    }
    lines.push('');
    if (data.toolTimeline.length > 1) {
      lines.push('Tool timeline (each arrow is a switch):', '');
      for (const b of data.toolTimeline) {
        const span = b.from === b.to ? fmt(b.from) : `${fmt(b.from)} → ${fmt(b.to)}`;
        lines.push(`- **${toolLabel(b.tool)}** · ${span} · ${b.count} event(s)`);
      }
      lines.push('');
    }
  }

  // Prompts & AI exchanges — the heart of the report. In HTML this becomes
  // collapsible cards; in Markdown it reads top-to-bottom.
  lines.push('## Prompts & AI exchanges', '');
  if (turnsPlaceholder) {
    lines.push(TURNS_PLACEHOLDER, '');
  } else if (data.turns.length === 0) {
    lines.push('_No prompts recorded._', '');
  } else {
    for (const turn of data.turns) {
      turnMarkdown(lines, turn);
    }
  }

  lines.push('## Authorship statement', '');
  lines.push('> ' + data.authorship, '');

  return lines.join('\n');
}

/** Render a report as student- and educator-friendly Markdown. */
export function renderMarkdown(data: ReportData): string {
  return buildMarkdown(data, false);
}

/**
 * A link from a report (written to `.showtail/reports/`) to a repo-relative file.
 * `code.path` is already forward-slash repo-relative, so we just step up out of
 * `reports/` and `.showtail/` and URL-encode each segment (handles spaces, etc.).
 * Relative + forward-slash means it resolves the same in any browser or Markdown
 * viewer, on any OS, and stays valid when the report is committed and shared.
 */
function fileHref(repoRelPath: string): string {
  return '../../' + repoRelPath.split('/').map(encodeURIComponent).join('/');
}

/** Append one turn as readable Markdown (used for the canonical text export). */
function turnMarkdown(lines: string[], turn: Turn): void {
  const meta = `\`${staticUtc(turn.prompt.timestamp)}\` · \`${toolLabel(turn.tool)}\``;
  lines.push(`**Prompt** · ${meta}`, '');
  lines.push(turn.prompt.text, '');
  for (const ai of turn.aiOutputs) {
    lines.push('_AI response:_', '');
    lines.push(ai.text, '');
  }
  for (const code of turn.codeChanges) {
    const stat = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
    lines.push(
      `_Suggested code — [\`${code.path}\`](${fileHref(code.path)})${stat}:_`,
      '',
    );
    if (code.diff) {
      lines.push('```diff', code.diff, '```', '');
    }
  }
}

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
  const title = data.project ? `Showtail Report — ${data.project}` : 'Showtail Report';
  const body = markdownToHtml(buildMarkdown(data, true))
    .replace(`<p>${TURNS_PLACEHOLDER}</p>`, turnsHtml(data))
    // Swap the timestamp tokens emitted in HTML mode for real <time> elements
    // (the turn cards already embed <time> directly, so they carry no tokens).
    .replace(TIME_TOKEN, (_m, iso: string) => timeTag(iso));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1b1b1f;
    background: #fbfbfd;
    max-width: 52rem;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  /* Timezone selector bar: a strip at the top of the document, spanning the
     content column's edges. It is not pinned, so it scrolls away with the page. */
  .st-tzbar {
    margin: 0 -1.5rem 1.75rem;
    padding: 0.55rem 1.5rem;
    background: #f1f1f5;
    border-bottom: 1px solid #e3e3e8;
    font-size: 0.8rem;
    color: #6b6b76;
  }
  .st-tzbar select {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.1rem 0.35rem;
    border: 1px solid #c7c7d0;
    border-radius: 0.25rem;
    background: #fff;
    color: #1b1b1f;
  }
  h1 { font-size: 1.9rem; margin: 0 0 0.25rem; }
  h2 {
    font-size: 1.25rem;
    margin: 2.25rem 0 0.75rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid #e3e3e8;
  }
  ul { padding-left: 1.25rem; }
  li { margin: 0.35rem 0; }
  p { margin: 0.6rem 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85em;
    background: #ecedf1;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
  }
  em { color: #6b6b76; font-style: normal; font-size: 0.9em; }
  blockquote {
    margin: 0.75rem 0;
    padding: 0.75rem 1rem;
    border-left: 4px solid #b7b7c2;
    background: #f1f1f5;
    color: #3a3a42;
    border-radius: 0 0.25rem 0.25rem 0;
  }
  /* Prompt-and-AI exchange cards */
  .turn {
    border: 1px solid #e3e3e8;
    border-radius: 0.5rem;
    margin: 0.35rem 0;
    background: #fff;
    overflow: hidden;
  }
  .turn > summary {
    cursor: pointer;
    padding: 0.4rem 0.9rem;
    line-height: 1.35;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  .turn > summary::-webkit-details-marker { display: none; }
  .turn > summary::before { content: "▸"; color: #9a9aa6; }
  .turn[open] > summary::before { content: "▾"; }
  .turn .prompt-text { font-weight: 600; flex: 1 1 16rem; }
  .badge {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.08rem 0.45rem;
    border-radius: 0.7rem;
    background: #e7e9f5;
    color: #3a3f6b;
  }
  /* Per-tool pastel colors so switches between AI tools stand out at a glance. */
  .badge--claude-code    { background: #ffe6d5; color: #9c4221; }
  .badge--google-gemini  { background: #d8e6fb; color: #1f4f9c; }
  .badge--chatgpt        { background: #d4f0e2; color: #1d6b4c; }
  .badge--codex          { background: #e7defb; color: #5b3a9c; }
  .badge--github-copilot { background: #e2e5ec; color: #3a4253; }
  .badge--cli            { background: #ebe8e2; color: #5a554b; }
  .turn .time { font-size: 0.78rem; color: #8a8a94; }
  .turn .stat { font-size: 0.78rem; color: #8a8a94; }
  .turn-body { padding: 0 0.9rem 0.8rem; }
  .turn-body h4 { margin: 0.8rem 0 0.3rem; font-size: 0.85rem; color: #6b6b76; }
  .ai-text { margin: 0.2rem 0 0.6rem; }
  .ai-text p { margin: 0.4rem 0; }
  .ai-text ul, .ai-text ol { margin: 0.4rem 0; padding-left: 1.4rem; }
  .ai-text li { margin: 0.15rem 0; }
  .ai-text .md-h { font-weight: 600; margin: 0.7rem 0 0.3rem; }
  .ai-text strong { font-weight: 600; }
  .ai-text em { font-style: italic; color: inherit; font-size: inherit; }
  .ai-text a { color: #3a3f9b; }
  .ai-text blockquote {
    margin: 0.5rem 0;
    padding: 0.3rem 0.8rem;
    border-left: 3px solid #c9c9d2;
    color: #4a4a52;
  }
  .ai-sep { border: none; border-top: 1px solid #e3e3e8; margin: 0.7rem 0; }
  .turn-close {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem;
    font: inherit;
    font-size: 0.8rem;
    text-align: center;
    color: #5c5f78;
    background: #f3f4f9;
    border: none;
    border-top: 1px solid #e3e3e8;
    cursor: pointer;
  }
  .turn-close:hover { background: #e8eaf4; color: #2f3566; }
  .prompt-block {
    margin: 0.3rem 0 0.6rem;
    padding: 0.2rem 0 0.2rem 0.7rem;
    border-left: 3px solid #c6cbf0;
  }
  .role-tag {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8a8a94;
  }
  .prompt-block .ai-text { margin: 0.1rem 0 0; }
  .code { margin: 0.4rem 0; }
  .code > summary { cursor: pointer; font-size: 0.85rem; color: #3a3f6b; }
  .file-link { color: #3a3f6b; text-decoration: none; font-weight: 600; }
  .file-link:hover { text-decoration: underline; }
  pre.diff {
    margin: 0.4rem 0 0;
    padding: 0.6rem 0;
    background: #f6f6f9;
    border-radius: 0.35rem;
    overflow-x: auto;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .dline { display: block; padding-right: 0.8rem; }
  .dline.add { background: #e6ffec; }
  .dline.del { background: #ffebe9; }
  .dmark {
    display: inline-block;
    width: 1.6rem;
    text-align: center;
    color: #8a8a94;
    user-select: none;
  }
  .dline.add .dmark { color: #1a7f37; background: #ccffd8; }
  .dline.del .dmark { color: #cf222e; background: #ffd7d5; }
  /* Shared syntax theme (GitHub Primer) for diffs and code blocks. */
  .tok-kw { color: #cf222e; }
  .tok-str { color: #0a3069; }
  .tok-com { color: #6e7781; font-style: italic; }
  .tok-num { color: #0550ae; }
  .tok-fn { color: #8250df; }
  /* Code boxes inside an AI response / prompt (a code box with a code font). */
  pre.codeblock {
    margin: 0.4rem 0 0.6rem;
    padding: 0.6rem 0.8rem;
    background: #f6f6f9;
    border: 1px solid #e3e3e8;
    border-radius: 0.35rem;
    overflow-x: auto;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  pre.codeblock code { background: none; padding: 0; font-size: inherit; border-radius: 0; }
  .code-lang {
    display: inline-block;
    margin: 0.4rem 0 0;
    padding: 0.1rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.7rem;
    color: #6b6b76;
    background: #ececf1;
    border: 1px solid #e3e3e8;
    border-bottom: none;
    border-radius: 0.35rem 0.35rem 0 0;
  }
  .code-lang + pre.codeblock { margin-top: 0; border-top-left-radius: 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e4ea; background: #18181b; }
    .st-tzbar { background: #1f1f23; border-bottom-color: #34343a; color: #a0a0aa; }
    .st-tzbar select { background: #2a2a30; color: #e4e4ea; border-color: #44444c; }
    h2 { border-bottom-color: #34343a; }
    code { background: #2a2a30; }
    em { color: #a0a0aa; }
    blockquote { background: #242429; border-left-color: #4a4a52; color: #cfcfd6; }
    .turn { background: #1f1f23; border-color: #34343a; }
    .badge { background: #2c2f45; color: #c6cbf0; }
    .badge--claude-code    { background: #4a2c1c; color: #ffc6a3; }
    .badge--google-gemini  { background: #1d3252; color: #a6c8f5; }
    .badge--chatgpt        { background: #1b3d2f; color: #9ce3c1; }
    .badge--codex          { background: #322a4d; color: #cdb6f5; }
    .badge--github-copilot { background: #2d313c; color: #c2c9d8; }
    .badge--cli            { background: #33312b; color: #cfc9bb; }
    pre.diff { background: #242429; }
    .dline.add { background: rgba(46, 160, 67, 0.15); }
    .dline.del { background: rgba(248, 81, 73, 0.15); }
    .dmark { color: #8a8a94; }
    .dline.add .dmark { color: #3fb950; background: rgba(63, 185, 80, 0.3); }
    .dline.del .dmark { color: #f85149; background: rgba(248, 81, 73, 0.3); }
    .tok-kw { color: #ff7b72; }
    .tok-str { color: #a5d6ff; }
    .tok-com { color: #8b949e; }
    .tok-num { color: #79c0ff; }
    .tok-fn { color: #d2a8ff; }
    pre.codeblock { background: #242429; border-color: #34343a; }
    .code-lang { background: #2a2a30; border-color: #34343a; color: #a0a0aa; }
    .ai-text a { color: #aab0ff; }
    .file-link { color: #aab0ff; }
    .ai-text blockquote { border-left-color: #4a4a52; color: #b8b8c2; }
    .ai-sep { border-top-color: #34343a; }
    .turn-close { color: #b8b8c2; background: #242429; border-top-color: #34343a; }
    .turn-close:hover { background: #2c2c33; color: #e4e4ea; }
  }
</style>
</head>
<body>
<div class="st-tzbar">Times shown in <select id="st-tz" aria-label="Display timezone"></select></div>
${body}
<script>
(function () {
  var sel = document.getElementById('st-tz');
  if (!sel) return;
  var local = 'UTC';
  try { local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
  var zones = null;
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch (e) { zones = null; }
  if (!zones || !zones.length) {
    zones = ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
      'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
      'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai',
      'Asia/Tokyo', 'Australia/Sydney'];
  }
  if (zones.indexOf(local) === -1) zones = [local].concat(zones);
  var saved = null;
  try { saved = localStorage.getItem('showtail-tz'); } catch (e) {}
  var current = (saved && zones.indexOf(saved) !== -1) ? saved : local;
  // The short code (e.g. PDT) plus the numeric GMT offset (e.g. GMT-7), both
  // derived from Intl; they collapse to one when the abbreviation is the offset.
  function zonePart(tz, type) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: type }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
    } catch (e) {}
    return '';
  }
  function zoneLabel(tz) {
    var name = zonePart(tz, 'short');
    var offset = zonePart(tz, 'shortOffset');
    if (name && offset && name !== offset) return tz + ' (' + name + ', ' + offset + ')';
    var code = offset || name;
    return code ? tz + ' (' + code + ')' : tz;
  }
  for (var i = 0; i < zones.length; i++) {
    var o = document.createElement('option');
    o.value = zones[i];
    o.textContent = zoneLabel(zones[i]);
    if (zones[i] === current) o.selected = true;
    sel.appendChild(o);
  }
  function render(tz) {
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short', timeZone: tz
      });
    } catch (e) { return; }
    var nodes = document.querySelectorAll('time.st-time');
    for (var i = 0; i < nodes.length; i++) {
      var d = new Date(nodes[i].getAttribute('datetime'));
      if (!isNaN(d.getTime())) nodes[i].textContent = fmt.format(d);
    }
  }
  sel.addEventListener('change', function () {
    try { localStorage.setItem('showtail-tz', sel.value); } catch (e) {}
    render(sel.value);
  });
  render(current);
})();
</script>
</body>
</html>
`;
}

/** Render the interactive exchange cards (escaped; no scripts). */
function turnsHtml(data: ReportData): string {
  if (data.turns.length === 0) return '<p><em>No prompts recorded.</em></p>';
  const out: string[] = [];
  for (const turn of data.turns) {
    const fileCount = turn.codeChanges.length;
    const lineCount = turn.codeChanges.reduce((n, c) => n + (c.diffLines ?? 0), 0);
    const stat =
      fileCount === 0
        ? 'no edits'
        : `edited ${fileCount} file(s)${lineCount ? `, ~${lineCount} line(s)` : ''}`;

    out.push('<details class="turn">');
    out.push(
      '<summary>' +
        `<span class="prompt-text">${escapeHtml(firstLine(turn.prompt.text))}</span>` +
        `<span class="badge badge--${escapeHtml(turn.tool)}">${escapeHtml(toolLabel(turn.tool))}</span>` +
        `<span class="time">${timeTag(turn.prompt.timestamp)}</span>` +
        `<span class="stat">${escapeHtml(stat)}</span>` +
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
    for (const code of turn.codeChanges) {
      const stat2 = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
      out.push('<details class="code">');
      out.push(
        '<summary>' +
          `<a class="file-link" href="${escapeHtml(fileHref(code.path))}" ` +
          'target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
          `${escapeHtml(code.path)}</a>${escapeHtml(stat2)}</summary>`,
      );
      if (code.diff) out.push(diffHtml(code.diff));
      out.push('</details>');
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

/** The first non-empty line of a string (for a card's collapsed summary). */
function firstLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

/** Escape the five characters that are unsafe in HTML text/attribute content. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render prompt/AI text (Markdown) for a turn card: fenced code becomes a real
 * monospace code box, and the prose between fences is rendered as a small
 * Markdown subset (headings, lists, quotes, rules, bold/italic/code/links).
 * Everything is escaped before formatting, so no script can slip through, and
 * only http/https links become anchors.
 */
function renderRichText(text: string): string {
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

/** Escape a run, then apply inline Markdown: code, bold, italic, links. */
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s.,)])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,)])/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    );
}

/**
 * Render a Markdown prose run (no fenced code — that's handled above) into HTML:
 * headings, unordered/ordered lists, blockquotes, horizontal rules, paragraphs.
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
      out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
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
      out.push(`<div class="md-h">${inlineMd(mm[2]!)}</div>`);
    } else if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(`<li>${inlineMd(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
    } else if (/^>\s?/.test(line)) {
      flushList();
      flushPara();
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`);
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

/** A monospace code box (no view-time JS) with an optional language label. */
function codeBox(code: string, lang: string): string {
  const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : '';
  // Syntax-highlight per line (highlightCode escapes), sharing the diff's theme.
  const body = code.replace(/\n$/, '').split('\n').map(highlightCode).join('\n');
  return `${label}<pre class="codeblock"><code>${body}</code></pre>`;
}

/**
 * Convert the small Markdown subset that `renderMarkdown` emits into HTML.
 * Deliberately minimal (no dependency): headings, unordered lists, blockquotes,
 * paragraphs, and inline bold/italic/code. Source text is HTML-escaped *before*
 * inline formatting is applied, so embedded `<script>` is neutralized; the usual
 * Markdown ambiguity (a literal `_` or `**` inside user text) is acceptable here.
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
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      flushList();
      flushQuote();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith('> ')) {
      flushList();
      (quoteLines ??= []).push(inline(line.slice(2)));
    } else if (line.startsWith('- ')) {
      flushQuote();
      listItems ??= [];
      // A bullet may carry an indented continuation line (the metadata), joined
      // to the item with a `<br>` to mirror the Markdown hard line break.
      let item = inline(line.slice(2).replace(/\s+$/, ''));
      let next = lines[i + 1];
      while (next !== undefined && /^\s{2,}\S/.test(next)) {
        item += `<br>${inline(next.trim())}`;
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
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();
  flushQuote();
  return out.join('\n');
}

/** Escape a single line, then apply inline `**bold**`, `_italic_`, `` `code` ``. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,)])/g, '$1<em>$2</em>');
}

/**
 * A readable, locale-independent UTC rendering (e.g. `2026-06-20 21:30 UTC`).
 * This is the static fallback shown wherever the timezone script can't run: the
 * Markdown export, printing, and HTML viewed with JavaScript disabled.
 */
function staticUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace(/\.\d{3}Z$/, 'Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * A placeholder for a timestamp in the Markdown-for-HTML stream. It uses no
 * Markdown-special characters, so it survives `markdownToHtml` untouched and is
 * swapped for a real `<time>` element by {@link renderHtml}. ISO instants never
 * contain `@`, so the delimiter is unambiguous.
 */
function timeToken(iso: string): string {
  return `SHOWTAILTIME@${iso}@`;
}

/** Matches {@link timeToken} output for the post-Markdown swap to `<time>` tags. */
const TIME_TOKEN = /SHOWTAILTIME@([^@]+)@/g;

/**
 * A `<time>` element carrying the raw UTC instant plus a static UTC fallback.
 * The inline timezone script re-renders its text in the viewer's chosen zone;
 * with JavaScript off it still reads as a valid UTC timestamp.
 */
function timeTag(iso: string): string {
  return `<time class="st-time" datetime="${escapeHtml(iso)}">${escapeHtml(staticUtc(iso))}</time>`;
}
