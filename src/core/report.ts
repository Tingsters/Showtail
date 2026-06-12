import type { Artifact, Event, ReportData, Session, TimelineEntry } from '../types.ts';
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

/** Build the structured report data from everything recorded in the project. */
export function buildReportData(paths: ShowtailPaths): ReportData {
  const config = readConfig(paths);
  const sessions = readSessions(paths);
  const artifacts = readArtifacts(paths);
  const events = readAllEventsWithSession(paths).map((x) => x.event);

  const byType = (type: Event['type']): Event[] => events.filter((e) => e.type === type);

  const timeline = buildTimeline(sessions, paths);

  return {
    project: config.project ?? null,
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: sessions.length,
      events: events.length,
      artifacts: artifacts.length,
    },
    timeline,
    prompts: byType('prompt'),
    decisions: byType('decision'),
    artifactsCreated: artifacts,
    tests: byType('test'),
    reflections: byType('reflection'),
    sources: byType('source'),
    authorship: buildAuthorshipStatement(config.project),
  };
}

function buildTimeline(sessions: Session[], paths: ShowtailPaths): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const { event, sessionId } of readAllEventsWithSession(paths)) {
    entries.push({
      timestamp: event.timestamp,
      kind: event.type,
      text: event.text,
      sessionId,
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
    });
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
}

function buildAuthorshipStatement(project?: string): string {
  const name = project ? `"${project}"` : 'this project';
  return (
    `I recorded this trail while working on ${name}. It shows the prompts I used, ` +
    `the decisions I made, the sources I drew on, the tests I ran, and my own ` +
    `reflections. The work and understanding represented here are my own.`
  );
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
      lines.push(`- \`${formatDate(entry.timestamp)}\` **${label}** — ${entry.text}`);
    }
    lines.push('');
  }

  section(lines, 'Prompts used', data.prompts, (e) => bullet(e));
  section(lines, 'Major decisions', data.decisions, (e) => bullet(e));
  section(lines, 'Sources used', data.sources, (e) => bullet(e));
  section(lines, 'Tests & validation', data.tests, (e) => bullet(e));

  // Artifacts get a richer rendering.
  lines.push('## Artifacts created', '');
  if (data.artifactsCreated.length === 0) {
    lines.push('_No artifacts recorded._', '');
  } else {
    for (const a of data.artifactsCreated) {
      lines.push(
        `- **${a.path}** — \`${shortHash(a.sha256)}\` ` +
          `(${formatDate(a.timestamp)}${a.gitCommit ? `, commit \`${shortHash(a.gitCommit)}\`` : ''})`,
      );
    }
    lines.push('');
  }

  section(lines, 'Student reflections', data.reflections, (e) => bullet(e));

  lines.push('## Authorship statement', '');
  lines.push('> ' + data.authorship, '');

  return lines.join('\n');
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
