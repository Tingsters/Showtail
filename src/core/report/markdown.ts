import type { ReportData, Turn } from '../../types.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../plans.ts';
import {
  filesChanged,
  modelLabel,
  nameBySlugMap,
  shouldShowAuthor,
  toolLabel,
  turnModels,
  turnSegments,
} from './data.ts';
import { staticUtc, timeToken } from './time.ts';

/** A unique token swapped for the interactive turns HTML after Markdown→HTML. */
export const TURNS_PLACEHOLDER = 'SHOWTAIL_TURNS_PLACEHOLDER';

/**
 * How much of the AI's play-by-play a report shows. The report foregrounds the
 * student's work and subordinates AI narration; this controls that subordinate
 * layer without ever touching what was captured:
 *  - `collapsed` (default) — AI process behind a collapsed disclosure, present.
 *  - `full` — the same, but expanded by default.
 *  - `off` — AI text omitted from the rendering entirely (prompts, decisions, and
 *    changes are untouched).
 */
export type AiMode = 'full' | 'collapsed' | 'off';

/** Options shared by both renderers, controlling presentation (not capture). */
export interface ReportRenderOptions {
  ai?: AiMode;
}

/** Resolve the AI-display mode, defaulting to the tidy collapsed view. */
export function resolveAiMode(opts: ReportRenderOptions | undefined): AiMode {
  return opts?.ai ?? 'collapsed';
}

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
 * A link from a report (in `.showtail/reports/`) to a saved plan file (in
 * `.showtail/plans/`). `planPath` is `plans/<id>.md`, so we step up out of
 * `reports/` into `.showtail/` and URL-encode each segment.
 */
export function planHref(planPath: string): string {
  return '../' + planPath.split('/').map(encodeURIComponent).join('/');
}

/** The first non-empty line of a plan, stripped of a leading Markdown heading marker. */
function planTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.replace(/^#+\s*/, '').trim() || 'Plan';
}

/**
 * Render a report as student- and educator-friendly Markdown. When
 * `turnsPlaceholder` is set, the exchanges are emitted as a single placeholder
 * line (swapped for interactive HTML cards by {@link renderHtml}); otherwise the
 * exchanges render as readable Markdown for the canonical text export.
 */
export function buildMarkdown(
  data: ReportData,
  turnsPlaceholder = false,
  opts?: ReportRenderOptions,
): string {
  // In HTML mode, timestamps are emitted as tokens that {@link renderHtml} swaps
  // for interactive <time> elements; the canonical Markdown export uses static UTC.
  const fmt = turnsPlaceholder ? timeToken : staticUtc;
  return [
    ...metadataSection(data, fmt),
    ...contributorsSection(data),
    ...toolsSection(data, fmt),
    ...modelsSection(data),
    ...plansSection(data),
    ...turnsSection(data, turnsPlaceholder, resolveAiMode(opts)),
    ...authorshipSection(data),
  ].join('\n');
}

/**
 * Plans — a first-class, top-level index of every plan the AI proposed, each a
 * one-line entry (title + approval status) with a link to the saved plan file.
 * Omitted entirely when no plan was captured. The full plan still renders inline
 * in its turn below; this is the at-a-glance list a reviewer scans first.
 */
function plansSection(data: ReportData): string[] {
  if (data.plans.length === 0) return [];
  const lines = [`## Plans (${data.plans.length})`, ''];
  for (const p of data.plans) {
    const status =
      p.status === 'approved'
        ? ' · _approved_'
        : p.status === 'revised'
          ? ' · _revised_'
          : '';
    const link = p.planPath ? ` ([view plan file](${planHref(p.planPath)}))` : '';
    lines.push(`- 📋 ${planTitle(p.text)}${status}${link}`);
  }
  lines.push('');
  return lines;
}

/** Title, generation note, one-line summary, and the redaction note. */
function metadataSection(data: ReportData, fmt: (iso: string) => string): string[] {
  // The subject is always present (override → project name → folder name).
  const base = `Showtail Report — ${data.displayName}`;
  // A per-student report names whose work it is; the team report doesn't.
  const title = data.scope ? `${base} — ${data.scope.name}` : base;
  // Lead with the shape a reviewer actually scans for — how many prompts (tasks)
  // the student ran and how many files they built — then the judgment signals
  // (decisions/plans), with the raw session/event totals kept last as backing.
  const files = filesChanged(data.turns);
  const filesPart = files > 0 ? `, ${files} file(s) changed` : '';
  const decisionsPart =
    data.summary.decisions > 0 ? `, ${data.summary.decisions} decision(s)` : '';
  const plansPart = data.summary.plans > 0 ? `, ${data.summary.plans} plan(s)` : '';
  const lines = [
    `# ${title}`,
    '',
    `_Generated ${fmt(data.generatedAt)}_`,
    '',
    `**Summary:** ${data.turns.length} task(s)${filesPart}${decisionsPart}${plansPart} · ` +
      `${data.summary.sessions} session(s), ${data.summary.events} event(s), ` +
      `${data.summary.artifacts} artifact record(s).`,
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
 * Models used — which AI model(s) produced the responses. Only rendered when at
 * least one model was captured (older/model-less trails skip it entirely), so it
 * never shows an empty section.
 */
function modelsSection(data: ReportData): string[] {
  if (data.models.length === 0) return [];
  const lines = ['## Models used', ''];
  for (const m of data.models) {
    lines.push(`- **${modelLabel(m.model)}** — ${m.events} response(s)`);
  }
  lines.push('');
  return lines;
}

/**
 * Prompts & AI exchanges — the heart of the report. In HTML this becomes
 * collapsible cards; in Markdown it reads top-to-bottom.
 */
function turnsSection(data: ReportData, turnsPlaceholder: boolean, ai: AiMode): string[] {
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
    turnMarkdown(lines, turn, ai, author);
  }
  return lines;
}

function authorshipSection(data: ReportData): string[] {
  return ['## Authorship statement', '', '> ' + data.authorship, ''];
}

/** Render a report as student- and educator-friendly Markdown. */
export function renderMarkdown(data: ReportData, opts?: ReportRenderOptions): string {
  return buildMarkdown(data, false, opts);
}

/** Append one turn as readable Markdown (used for the canonical text export). */
function turnMarkdown(lines: string[], turn: Turn, ai: AiMode, author?: string): void {
  const who = author ? ` · **${author}**` : '';
  const models = turnModels(turn)
    .map((m) => ` · \`${modelLabel(m)}\``)
    .join('');
  const meta = `\`${staticUtc(turn.prompt.timestamp)}\` · \`${toolLabel(turn.tool)}\`${models}${who}`;
  lines.push(`**Prompt** · ${meta}`, '');
  lines.push(turn.prompt.text, '');

  // One chronological stream: work items inline; each run of AI messages as one
  // collapsed <details> in place (GitHub renders it). `--ai off` drops the AI runs.
  for (const seg of turnSegments(turn)) {
    if (seg.kind === 'ai') {
      if (ai === 'off') continue;
      const n = seg.events.length;
      const open = ai === 'full' ? ' open' : '';
      lines.push(
        `<details${open}><summary>🤖 ${n} AI message(s)</summary>`,
        '',
        ...seg.events.map((e) => aiText(e.text)),
        '</details>',
        '',
      );
      continue;
    }
    const item = seg.item;
    if (item.kind === 'decision') {
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
      if (item.event.planPath) {
        lines.push(`_[view plan file](${planHref(item.event.planPath)})_`, '');
      }
    } else if (item.kind === 'code') {
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

/** One AI message as a labelled Markdown block, with a trailing blank line. */
function aiText(text: string): string {
  return `_AI response:_\n\n${text}\n`;
}
