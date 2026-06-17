import type {
  Artifact,
  Event,
  JournalEntry,
  ReportData,
  Session,
  TimelineEntry,
  Tool,
  ToolBlock,
  ToolUsage,
  Turn,
} from '../types.ts';
import { TOOL_LABELS } from '../types.ts';
import { readArtifacts } from './artifacts.ts';
import { readAllEventsWithSession } from './events.ts';
import { readObject } from './objects.ts';
import { readConfig, readJournal, readSessions, type ShowtailPaths } from './storage.ts';

/** A short, student-friendly label for each event type. */
const TYPE_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  ai_output: 'AI output',
  human_edit: 'Hand-written edit',
  decision: 'Decision',
  reflection: 'Reflection',
  source: 'Source',
  test: 'Test / validation',
  artifact: 'Artifact',
};

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

  const byType = (type: Event['type']): Event[] => events.filter((e) => e.type === type);
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
    timeline: buildTimeline(withSession, sessions),
    prompts: byType('prompt'),
    importedChatgpt: events.filter((e) => toolOf(e) === 'chatgpt'),
    importedGemini: events.filter((e) => toolOf(e) === 'google-gemini'),
    decisions: byType('decision'),
    artifactsCreated: artifacts,
    tests: byType('test'),
    reflections: byType('reflection'),
    sources: byType('source'),
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

function buildTimeline(
  withSession: EventWithSession[],
  sessions: Session[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const { event, sessionId } of withSession) {
    entries.push({
      timestamp: event.timestamp,
      kind: event.type,
      text: event.text,
      sessionId,
      tool: toolOf(event),
    });
  }
  for (const session of sessions) {
    entries.push({
      timestamp: session.startedAt,
      kind: 'session_start',
      text: session.label
        ? `Started session "${session.label}"`
        : 'Started a work session',
      sessionId: session.id,
      tool: session.tool,
    });
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
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
    `I recorded this trail while working on ${name}. It shows the prompts I used, ` +
    `the decisions I made, the sources I drew on, the tests I ran, and my own ` +
    `reflections.${toolList} The work and understanding represented here are my own.`
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

  lines.push(`# ${title}`, '');
  lines.push(`_Generated ${formatDate(data.generatedAt)}_`, '');
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
        const span =
          b.from === b.to
            ? formatDate(b.from)
            : `${formatDate(b.from)} → ${formatDate(b.to)}`;
        lines.push(`- **${toolLabel(b.tool)}** · ${span} · ${b.count} event(s)`);
      }
      lines.push('');
    }
  }

  // Timeline
  lines.push('## Project timeline', '');
  if (data.timeline.length === 0) {
    lines.push('_No activity recorded yet._', '');
  } else {
    for (const entry of data.timeline) {
      const label =
        entry.kind === 'session_start'
          ? 'Session'
          : (TYPE_LABELS[entry.kind] ?? entry.kind);
      const badge = entry.tool ? ` \`${toolLabel(entry.tool)}\`` : '';
      lines.push(
        `- \`${formatDate(entry.timestamp)}\`${badge} **${label}** — ${entry.text}`,
      );
    }
    lines.push('');
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

  section(lines, 'Prompts used', data.prompts, (e) => bullet(e));

  // Imported ChatGPT work, grouped so the student can skim what an import added
  // (a paste backup records prompts here for review) without hunting the timeline.
  if (data.importedChatgpt.length > 0) {
    section(lines, 'Imported from ChatGPT', data.importedChatgpt, (e) => bullet(e));
  }
  if (data.importedGemini.length > 0) {
    section(lines, 'Imported from Google Gemini', data.importedGemini, (e) => bullet(e));
  }

  section(lines, 'Major decisions', data.decisions, (e) => bullet(e));
  section(lines, 'Sources used', data.sources, (e) => bullet(e));
  section(lines, 'Tests & validation', data.tests, (e) => bullet(e));

  // Artifacts get a richer rendering.
  lines.push('## Artifacts created', '');
  if (data.artifactsCreated.length === 0) {
    lines.push('_No artifacts recorded._', '');
  } else {
    for (const a of data.artifactsCreated) {
      const via = a.tool ? `, via ${toolLabel(a.tool as Tool)}` : '';
      lines.push(
        `- **${a.path}** — \`${shortHash(a.sha256)}\` ` +
          `(${formatDate(a.timestamp)}${a.gitCommit ? `, commit \`${shortHash(a.gitCommit)}\`` : ''}${via})`,
      );
    }
    lines.push('');
  }

  section(lines, 'Student reflections', data.reflections, (e) => bullet(e));

  lines.push('## Authorship statement', '');
  lines.push('> ' + data.authorship, '');

  return lines.join('\n');
}

/** Render a report as student- and educator-friendly Markdown. */
export function renderMarkdown(data: ReportData): string {
  return buildMarkdown(data, false);
}

/** Append one turn as readable Markdown (used for the canonical text export). */
function turnMarkdown(lines: string[], turn: Turn): void {
  const meta = `\`${formatDate(turn.prompt.timestamp)}\` · \`${toolLabel(turn.tool)}\``;
  lines.push(`**Prompt** · ${meta}`, '');
  lines.push(turn.prompt.text, '');
  for (const ai of turn.aiOutputs) {
    lines.push('_AI response:_', '');
    lines.push(ai.text, '');
  }
  for (const code of turn.codeChanges) {
    const stat = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
    lines.push(`_Suggested code — \`${code.path}\`${stat}:_`, '');
    if (code.diff) {
      lines.push('```diff', code.diff, '```', '');
    }
  }
}

/**
 * Render a report as a standalone HTML document. Most of the document is a
 * rendering of the Markdown returned by `renderMarkdown`; the "Prompts & AI
 * exchanges" section is rendered directly to interactive `<details>` cards
 * (which the Markdown subset can't express) and spliced in. No JavaScript: the
 * cards use native HTML disclosure, so the file stays self-contained and
 * printable.
 */
export function renderHtml(data: ReportData): string {
  const title = data.project ? `Showtail Report — ${data.project}` : 'Showtail Report';
  const body = markdownToHtml(buildMarkdown(data, true)).replace(
    `<p>${TURNS_PLACEHOLDER}</p>`,
    turnsHtml(data),
  );
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
    margin: 0.6rem 0;
    background: #fff;
    overflow: hidden;
  }
  .turn > summary {
    cursor: pointer;
    padding: 0.7rem 0.9rem;
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
  .turn .time { font-size: 0.78rem; color: #8a8a94; }
  .turn .stat { font-size: 0.78rem; color: #8a8a94; }
  .turn-body { padding: 0 0.9rem 0.8rem; }
  .turn-body h4 { margin: 0.8rem 0 0.3rem; font-size: 0.85rem; color: #6b6b76; }
  .ai-text { white-space: pre-wrap; margin: 0.2rem 0 0.6rem; }
  .code { margin: 0.4rem 0; }
  .code > summary { cursor: pointer; font-size: 0.85rem; color: #3a3f6b; }
  pre.diff {
    margin: 0.4rem 0 0;
    padding: 0.6rem 0.8rem;
    background: #f6f6f9;
    border-radius: 0.35rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  pre.diff .add { background: #e3f7e8; color: #18602a; display: block; }
  pre.diff .del { background: #fbe4e4; color: #8a1f1f; display: block; }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e4ea; background: #18181b; }
    h2 { border-bottom-color: #34343a; }
    code { background: #2a2a30; }
    em { color: #a0a0aa; }
    blockquote { background: #242429; border-left-color: #4a4a52; color: #cfcfd6; }
    .turn { background: #1f1f23; border-color: #34343a; }
    .badge { background: #2c2f45; color: #c6cbf0; }
    pre.diff { background: #242429; }
    pre.diff .add { background: #16331f; color: #8fdca2; }
    pre.diff .del { background: #3a1f1f; color: #e6a3a3; }
  }
</style>
</head>
<body>
${body}
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
        `<span class="badge">${escapeHtml(toolLabel(turn.tool))}</span>` +
        `<span class="time">${escapeHtml(formatDate(turn.prompt.timestamp))}</span>` +
        `<span class="stat">${escapeHtml(stat)}</span>` +
        '</summary>',
    );
    out.push('<div class="turn-body">');

    if (turn.prompt.text.trim() !== firstLine(turn.prompt.text)) {
      out.push('<h4>Prompt</h4>');
      out.push(`<div class="ai-text">${escapeHtml(turn.prompt.text)}</div>`);
    }
    for (const ai of turn.aiOutputs) {
      out.push('<h4>AI response</h4>');
      out.push(`<div class="ai-text">${escapeHtml(ai.text)}</div>`);
    }
    for (const code of turn.codeChanges) {
      const stat2 = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
      out.push('<details class="code">');
      out.push(
        `<summary>${escapeHtml(code.path)}${escapeHtml(stat2)}</summary>`,
      );
      if (code.diff) out.push(diffHtml(code.diff));
      out.push('</details>');
    }

    out.push('</div></details>');
  }
  return out.join('\n');
}

/** Render a diff as a <pre> with simple +/- line coloring (all escaped). */
function diffHtml(diff: string): string {
  const lines = diff.split('\n').map((line) => {
    const cls =
      /^\+(?!\+)/.test(line) ? 'add' : /^-(?!-)/.test(line) ? 'del' : '';
    const safe = escapeHtml(line) || '&nbsp;';
    return cls ? `<span class="${cls}">${safe}</span>` : safe;
  });
  return `<pre class="diff">${lines.join('\n')}</pre>`;
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

function section(
  lines: string[],
  heading: string,
  events: Event[],
  render: (e: Event) => string,
): void {
  lines.push(`## ${heading}`, '');
  if (events.length === 0) {
    lines.push('_None recorded._', '');
    return;
  }
  for (const e of events) lines.push(render(e));
  lines.push('');
}

function bullet(e: Event): string {
  const meta: string[] = [formatDate(e.timestamp)];
  meta.push(toolLabel(toolOf(e)));
  if (e.files && e.files.length > 0) meta.push(`files: ${e.files.join(', ')}`);
  if (e.tags && e.tags.length > 0) meta.push(`tags: ${e.tags.join(', ')}`);
  return `- ${e.text}  \n  _(${meta.join(' · ')})_`;
}

function formatDate(iso: string): string {
  // Keep it simple and locale-independent: trim milliseconds from ISO.
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
