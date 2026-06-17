import type {
  Artifact,
  Event,
  ReportData,
  Session,
  TimelineEntry,
  Tool,
  ToolBlock,
  ToolUsage,
} from '../types.ts';
import { TOOL_LABELS } from '../types.ts';
import { readAllEventsWithSession } from './events.ts';
import {
  readArtifacts,
  readConfig,
  readSessions,
  type ShowtailPaths,
} from './storage.ts';

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

/** Build the structured report data from everything recorded in the project. */
export function buildReportData(paths: ShowtailPaths): ReportData {
  const config = readConfig(paths);
  const sessions = readSessions(paths);
  const artifacts = readArtifacts(paths);
  const events = readAllEventsWithSession(paths).map((x) => x.event);

  const byType = (type: Event['type']): Event[] => events.filter((e) => e.type === type);

  const sorted = sortByTime(events);

  return {
    project: config.project ?? null,
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: sessions.length,
      events: events.length,
      artifacts: artifacts.length,
    },
    tools: buildToolUsage(events),
    toolTimeline: buildToolBlocks(sorted),
    timeline: buildTimeline(sessions, paths),
    prompts: byType('prompt'),
    importedChatgpt: events.filter((e) => toolOf(e) === 'chatgpt'),
    importedGemini: events.filter((e) => toolOf(e) === 'google-gemini'),
    decisions: byType('decision'),
    artifactsCreated: artifacts,
    tests: byType('test'),
    reflections: byType('reflection'),
    sources: byType('source'),
    authorship: buildAuthorshipStatement(config.project, buildToolUsage(events)),
  };
}

function sortByTime(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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

function buildTimeline(sessions: Session[], paths: ShowtailPaths): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const { event, sessionId } of readAllEventsWithSession(paths)) {
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

/** Render a report as student- and educator-friendly Markdown. */
export function renderMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const title = data.project ? `Showtail Report — ${data.project}` : 'Showtail Report';

  lines.push(`# ${title}`, '');
  lines.push(`_Generated ${formatDate(data.generatedAt)}_`, '');
  lines.push(
    `**Summary:** ${data.summary.sessions} session(s), ` +
      `${data.summary.events} event(s), ${data.summary.artifacts} artifact record(s).`,
    '',
  );

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

/**
 * Render a report as a standalone HTML document. The HTML is a rendering of the
 * exact same Markdown returned by `renderMarkdown`, so the Markdown stays the
 * single source of truth and the two views can never drift apart.
 */
export function renderHtml(data: ReportData): string {
  const title = data.project ? `Showtail Report — ${data.project}` : 'Showtail Report';
  const body = markdownToHtml(renderMarkdown(data));
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
  @media (prefers-color-scheme: dark) {
    body { color: #e4e4ea; background: #18181b; }
    h2 { border-bottom-color: #34343a; }
    code { background: #2a2a30; }
    em { color: #a0a0aa; }
    blockquote { background: #242429; border-left-color: #4a4a52; color: #cfcfd6; }
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;
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
