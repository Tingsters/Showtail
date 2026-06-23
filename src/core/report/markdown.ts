import type { ReportData, Turn } from '../../types.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../plans.ts';
import { nameBySlugMap, shouldShowAuthor, toolLabel, turnTimeline } from './data.ts';
import { staticUtc, timeToken } from './time.ts';

/** A unique token swapped for the interactive turns HTML after Markdown→HTML. */
export const TURNS_PLACEHOLDER = 'SHOWTAIL_TURNS_PLACEHOLDER';

/**
 * A link from a report (written to `.showtail/reports/`) to a repo-relative file.
 * `code.path` is already forward-slash repo-relative, so we just step up out of
 * `reports/` and `.showtail/` and URL-encode each segment (handles spaces, etc.).
 * Relative + forward-slash means it resolves the same in any browser or Markdown
 * viewer, on any OS, and stays valid when the report is committed and shared.
 */
export function fileHref(repoRelPath: string): string {
  return '../../' + repoRelPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Render a report as student- and educator-friendly Markdown. When
 * `turnsPlaceholder` is set, the exchanges are emitted as a single placeholder
 * line (swapped for interactive HTML cards by {@link renderHtml}); otherwise the
 * exchanges render as readable Markdown for the canonical text export.
 */
export function buildMarkdown(data: ReportData, turnsPlaceholder = false): string {
  // In HTML mode, timestamps are emitted as tokens that {@link renderHtml} swaps
  // for interactive <time> elements; the canonical Markdown export uses static UTC.
  const fmt = turnsPlaceholder ? timeToken : staticUtc;
  return [
    ...metadataSection(data, fmt),
    ...contributorsSection(data),
    ...toolsSection(data, fmt),
    ...turnsSection(data, turnsPlaceholder),
    ...authorshipSection(data),
  ].join('\n');
}

/** Title, generation note, one-line summary, and the redaction note. */
function metadataSection(data: ReportData, fmt: (iso: string) => string): string[] {
  // The subject is always present (override → project name → folder name).
  const base = `Showtail Report — ${data.displayName}`;
  // A per-student report names whose work it is; the team report doesn't.
  const title = data.scope ? `${base} — ${data.scope.name}` : base;
  const decisionsPart =
    data.summary.decisions > 0 ? `, ${data.summary.decisions} decision(s)` : '';
  const plansPart = data.summary.plans > 0 ? `, ${data.summary.plans} plan(s)` : '';
  const lines = [
    `# ${title}`,
    '',
    `_Generated ${fmt(data.generatedAt)}_`,
    '',
    `**Summary:** ${data.summary.sessions} session(s), ` +
      `${data.summary.events} event(s), ${data.summary.artifacts} artifact record(s)` +
      `${decisionsPart}${plansPart}.`,
    '',
  ];
  if (data.redactionCount > 0) {
    lines.push(
      `_Showtail removed ${data.redactionCount} secret(s)/personal detail(s) ` +
        `before saving._`,
      '',
    );
  }
  return lines;
}

/**
 * Contributors — who worked on this, and how much. Shown on the team report;
 * a single-student report omits it (it's just them).
 */
function contributorsSection(data: ReportData): string[] {
  if (!shouldShowAuthor(data)) return [];
  const lines = ['## Contributors', ''];
  for (const c of data.contributors) {
    lines.push(
      `- **${c.name}** (\`${c.slug}\`) — ${c.events} event(s), ${c.artifacts} file record(s)`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * Tools used — up front so a reviewer can see, at a glance, which tools the
 * student used and when they switched between them.
 */
function toolsSection(data: ReportData, fmt: (iso: string) => string): string[] {
  const lines = ['## Tools used', ''];
  if (data.tools.length === 0) {
    lines.push('_No tool activity recorded._', '');
    return lines;
  }
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
  return lines;
}

/**
 * Prompts & AI exchanges — the heart of the report. In HTML this becomes
 * collapsible cards; in Markdown it reads top-to-bottom.
 */
function turnsSection(data: ReportData, turnsPlaceholder: boolean): string[] {
  const lines = ['## Prompts & AI exchanges', ''];
  if (turnsPlaceholder) {
    lines.push(TURNS_PLACEHOLDER, '');
    return lines;
  }
  if (data.turns.length === 0) {
    lines.push('_No prompts recorded._', '');
    return lines;
  }
  const showAuthor = shouldShowAuthor(data);
  const nameBySlug = nameBySlugMap(data.contributors);
  for (const turn of data.turns) {
    const author = showAuthor
      ? (nameBySlug.get(turn.actorSlug) ?? turn.actorSlug)
      : undefined;
    turnMarkdown(lines, turn, author);
  }
  return lines;
}

function authorshipSection(data: ReportData): string[] {
  return ['## Authorship statement', '', '> ' + data.authorship, ''];
}

/** Render a report as student- and educator-friendly Markdown. */
export function renderMarkdown(data: ReportData): string {
  return buildMarkdown(data, false);
}

/** Append one turn as readable Markdown (used for the canonical text export). */
function turnMarkdown(lines: string[], turn: Turn, author?: string): void {
  const who = author ? ` · **${author}**` : '';
  const meta = `\`${staticUtc(turn.prompt.timestamp)}\` · \`${toolLabel(turn.tool)}\`${who}`;
  lines.push(`**Prompt** · ${meta}`, '');
  lines.push(turn.prompt.text, '');
  // AI replies, decisions, and code changes interleaved in the order they happened.
  for (const item of turnTimeline(turn)) {
    if (item.kind === 'ai') {
      lines.push('_AI response:_', '');
      lines.push(item.event.text, '');
    } else if (item.kind === 'decision') {
      lines.push('🔀 **Decision** · _you chose from the options the AI offered_', '');
      lines.push(item.event.text, '');
    } else if (item.kind === 'plan') {
      // Approval status when the tool resolves one (Claude); a tool with no
      // approval flow (Codex) shows the plan with no status suffix.
      const approved = item.event.tags?.includes(PLAN_APPROVED_TAG);
      const revised = item.event.tags?.includes(PLAN_REVISED_TAG);
      const status = approved ? ' · _approved_' : revised ? ' · _revised_' : '';
      lines.push(`📋 **Plan**${status}`, '');
      lines.push(item.event.text, '');
    } else {
      const code = item.change;
      const stat = code.diffLines ? ` (~${code.diffLines} line(s))` : '';
      const link = `[\`${code.path}\`](${fileHref(code.linkPath ?? code.path)})`;
      if (code.diff) {
        lines.push(`_Suggested code — ${link}${stat}:_`, '');
        lines.push('```diff', code.diff, '```', '');
      } else {
        // No diff captured — name the changed file without promising code below it.
        lines.push(`_Changed file — ${link}${stat}._`, '');
      }
    }
  }
}
