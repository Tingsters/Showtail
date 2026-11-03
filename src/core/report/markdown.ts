import type { Event, ReportData, Turn } from '../../types.ts';
import { isNonBlockingDecisionText } from '../decisions.ts';
import { PLAN_APPROVED_TAG, PLAN_REVISED_TAG } from '../plans.ts';
import {
  filesChanged,
  formatDuration,
  modelLabel,
  nameBySlugMap,
  shouldShowAuthor,
  summarizeToolRun,
  toolLabel,
  turnModels,
  turnSegments,
} from './data.ts';
import { pluralS } from '../text.ts';
import { staticUtc, timeToken } from './time.ts';

/** A unique token swapped for the interactive turns HTML after Markdown→HTML. */
export const TURNS_PLACEHOLDER = 'SHOWTAIL_TURNS_PLACEHOLDER';

/**
 * How much of the AI's play-by-play a report shows. The report foregrounds the
 * student's work and subordinates AI narration — by visual weight now, not by
 * hiding it — without ever touching what was captured:
 *  - `collapsed` (default) — narration is shown as quiet railed prose; in HTML
 *    the client clamps the few passages that run very long.
 *  - `full` — the same, but nothing is clamped.
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
 * A code fence longer than any run of backticks inside `text`. A diff or prompt that
 * itself contains a fence (a Markdown sample, or text crafted to) would otherwise
 * close ours early and spill the rest of the report into the page.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
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
    ...coverageSection(data),
    ...contributorsSection(data),
    ...toolsSection(data, fmt),
    ...modelsSection(data),
    ...sessionStatsSection(data),
    ...plansSection(data),
    ...turnsSection(data, turnsPlaceholder, resolveAiMode(opts)),
    ...unattributedSection(data, turnsPlaceholder, resolveAiMode(opts)),
    ...fileObservationsSection(data, turnsPlaceholder, fmt),
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
  const tasks = data.turns.length;
  const { sessions, events, artifacts, decisions, plans } = data.summary;
  const filesPart = files > 0 ? `, ${files} file${pluralS(files)} changed` : '';
  const decisionsPart =
    decisions > 0 ? `, ${decisions} decision${pluralS(decisions)}` : '';
  const plansPart = plans > 0 ? `, ${plans} plan${pluralS(plans)}` : '';
  const lines = [
    `# ${title}`,
    '',
    `_Generated ${fmt(data.generatedAt)}_`,
    '',
    `**Summary:** ${tasks} task${pluralS(tasks)}${filesPart}${decisionsPart}${plansPart} · ` +
      `${sessions} session${pluralS(sessions)}, ${events} event${pluralS(events)}, ` +
      `${artifacts} artifact record${pluralS(artifacts)}.`,
    '',
  ];
  if (data.redactionCount > 0) {
    lines.push(
      `_Showtail removed ${data.redactionCount} secret${pluralS(data.redactionCount)}/personal detail${pluralS(data.redactionCount)} ` +
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
      `- **${c.name}** (\`${c.slug}\`) — ${c.events} event${pluralS(c.events)}, ${c.artifacts} file record${pluralS(c.artifacts)}`,
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
    lines.push(`- **${toolLabel(t.tool)}** — ${t.events} event${pluralS(t.events)}`);
  }
  lines.push('');
  if (data.toolTimeline.length > 1) {
    lines.push('Tool timeline (each arrow is a switch):', '');
    for (const b of data.toolTimeline) {
      const span = b.from === b.to ? fmt(b.from) : `${fmt(b.from)} → ${fmt(b.to)}`;
      lines.push(
        `- **${toolLabel(b.tool)}** · ${span} · ${b.count} event${pluralS(b.count)}`,
      );
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
    lines.push(`- **${modelLabel(m.model)}** — ${m.events} response${pluralS(m.events)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Session stats — total turn duration and token usage, from captured `recap`
 * events. Omitted entirely when none were captured (older trails, or a tool
 * that never surfaces this), so the section never shows all-zero stats.
 */
function sessionStatsSection(data: ReportData): string[] {
  const stats = data.summary.stats;
  if (!stats) return [];
  const lines = ['## Session stats', ''];
  if (stats.totalDurationMs > 0) {
    lines.push(`- **Total AI working time** — ${formatDuration(stats.totalDurationMs)}`);
  }
  const totalTokens =
    stats.totalInputTokens +
    stats.totalOutputTokens +
    stats.totalCacheReadTokens +
    stats.totalCacheCreationTokens;
  if (totalTokens > 0) {
    lines.push(
      `- **Total tokens** — ${totalTokens.toLocaleString()} ` +
        `(${stats.totalInputTokens.toLocaleString()} in, ` +
        `${stats.totalOutputTokens.toLocaleString()} out, ` +
        `${(stats.totalCacheReadTokens + stats.totalCacheCreationTokens).toLocaleString()} cached)`,
    );
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

/** File observations supplement incomplete native evidence; they are not edits. */
function fileObservationsSection(
  data: ReportData,
  html: boolean,
  fmt: (iso: string) => string,
): string[] {
  const observations =
    data.fileObservations?.filter((observation) => !observation.editId) ?? [];
  if (!observations.length) return [];
  if (html) return ['SHOWTAIL_FILE_OBSERVATIONS', ''];
  const lines = [
    '## File observations',
    '',
    'These observations may include later or manual changes and work from other processes. File hashes describe state when observed. Persisted workspace diffs show changes seen during a shell command, with unverified authorship.',
    '',
  ];
  for (const observation of observations) {
    const workspaceDelta = observation.basis === 'workspace-delta';
    const outcome = workspaceDelta
      ? 'shell activity'
      : observation.basis === 'shell-write-attempt'
        ? observation.toolOutcome === 'failed'
          ? 'a failed shell attempt'
          : observation.toolOutcome === 'succeeded'
            ? 'a successful shell attempt'
            : 'a shell attempt'
        : 'tool activity';
    lines.push(
      `- \`${observation.path.replace(/`/g, '')}\` · ${fmt(observation.observedAt)} · ${workspaceDelta ? 'during' : 'after'} ${outcome}${workspaceDelta ? ' · author unverified' : ''}`,
    );
    if (observation.sha256) lines.push(`  SHA-256: \`${observation.sha256}\``);
    if (workspaceDelta && observation.diff) {
      const fence = fenceFor(observation.diff);
      lines.push(
        '',
        '<details><summary>Observed workspace diff</summary>',
        '',
        fence + 'diff',
        observation.diff,
        fence,
        '',
        '</details>',
        '',
      );
    }
  }
  lines.push('');
  return lines;
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

  if (turn.recap?.durationMs) {
    lines.push(`_✻ Crunched for ${formatDuration(turn.recap.durationMs)}_`, '');
  }
  if (turn.recap?.text) {
    lines.push(`_Recap: ${turn.recap.text}_`, '');
  }

  // One chronological stream, in the order it happened. AI narration reads as
  // plain prose with no wrapper or label: everything else here is marked (the
  // prompt, 🔀 decisions, 📋 plans, 🛠 tool calls, code), so unlabelled text is
  // the AI talking. `--ai off` drops it.
  for (const seg of turnSegments(turn)) {
    if (seg.kind === 'ai') {
      if (ai === 'off') continue;
      for (const e of seg.events) lines.push(e.text, '');
      continue;
    }
    if (seg.kind === 'tools') {
      // A run of tool calls collapses like the AI run above: the mechanism is
      // one line until asked for, so a turn with dozens of calls stays readable.
      // A lone call needs no group — that would be chrome around one item.
      if (seg.events.length === 1) {
        lines.push(`🛠️ ${toolCallBlock(seg.events[0]!)}`, '');
      } else {
        lines.push(
          `<details><summary>${toolRunHeading(seg.events)}</summary>`,
          '',
          ...seg.events.map((e) => toolCallBlock(e)),
          '</details>',
          '',
        );
      }
      continue;
    }
    const item = seg.item;
    if (item.kind === 'decision') {
      lines.push(
        isNonBlockingDecisionText(item.event.text)
          ? '🔀 **Decision (non-blocking)** · _the AI kept working while it waited for your answer_'
          : '🔀 **Decision** · _you chose from the options the AI offered_',
        '',
      );
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
      if ((code.revisions?.length ?? 0) > 1) {
        lines.push(`_Captured revisions — ${code.path.replace(/`/g, '')}:_`, '');
        for (const [i, r] of code.revisions!.entries()) {
          lines.push(`Revision ${i + 1} · ${r.timestamp}`, '');
          if (r.diff) {
            const fence = fenceFor(r.diff);
            lines.push(fence + 'diff', r.diff, fence, '');
          } else
            lines.push(
              `Captured snapshot${r.sha256 ? ' · ' + r.sha256 : ' (content unavailable)'}.`,
              '',
            );
        }
        continue;
      }
      const stat = code.diffLines
        ? ` (~${code.diffLines} line${pluralS(code.diffLines)})`
        : '';
      const link = code.capturedOnly
        ? `\`${code.path.replace(/`/g, '')}\``
        : `[\`${code.path}\`](${fileHref(code.linkPath ?? code.path)})`;
      if (code.diff) {
        lines.push(`_Suggested code — ${link}${stat}:_`, '');
        const fence = fenceFor(code.diff);
        lines.push(`${fence}diff`, code.diff, fence, '');
      } else {
        // No diff captured — name the changed file without promising code below it.
        lines.push(`_Changed file — ${link}${stat}._`, '');
      }
    }
  }
}

/** The one-line heading for a run of tool calls: totals, then the busiest tools. */
function toolRunHeading(events: Event[]): string {
  const { total, byTool, failed } = summarizeToolRun(events);
  const breakdown = byTool.map((t) => `${t.count} ${t.name}`).join(' · ');
  const failedPart = failed > 0 ? ` · ⚠️ ${failed} failed` : '';
  return `🛠️ ${total} tool call${pluralS(total)}${breakdown ? ` · ${breakdown}` : ''}${failedPart}`;
}

/** One tool call inside a run: its name, then whatever it printed. */
function toolCallBlock(event: Event): string {
  const label = event.toolName ?? 'Tool';
  const badge = event.isError ? ' ⚠️ _error_' : '';
  return `**${label}**${badge}\n\n${event.text}\n`;
}

function coverageSection(data: ReportData): string[] {
  if (!data.coverage) return [];
  const c = data.coverage;
  const warnings = [...new Set(c.sources.flatMap((s) => s.warningCodes))];
  return [
    '## Capture coverage',
    '',
    `**${c.status}** · ${c.sources.filter((s) => s.status === 'reconciled').length} of ${c.sources.length} conversations reconciled with available sources.`,
    '',
    c.meaning,
    '',
    ...(warnings.length ? ['Source notes: ' + warnings.join(', ') + '.', ''] : []),
    ...(data.summary.fileGroups !== undefined
      ? [
          `${data.summary.artifacts} captured edits in ${data.summary.fileGroups} file groups. Expand revision history to inspect repeated edits.`,
          '',
        ]
      : []),
  ];
}
function unattributedSection(data: ReportData, html: boolean, ai: AiMode): string[] {
  if (!data.unattributedWork?.length) return [];
  if (html) return ['SHOWTAIL_UNATTRIBUTED_WORK', ''];
  const lines = [
    '## Work without a linked prompt',
    '',
    'These captured records have no established human prompt.',
    '',
  ];
  for (const work of data.unattributedWork) {
    lines.push(`### ${toolLabel(work.tool)} · ${work.sessionId}`, '');
    for (const e of work.events.filter((e) => e.type === 'user_text'))
      lines.push(
        e.origin === 'agent' ? 'Agent input:' : 'Unlinked provider user message:',
        '',
        e.text ?? '',
        '',
      );
    for (const c of work.codeChanges) {
      lines.push('Captured file: ' + c.path.replace(/`/g, ''), '');
      for (const r of c.revisions ?? [{ timestamp: c.timestamp, diff: c.diff }])
        if (r.diff) {
          const fence = fenceFor(r.diff);
          lines.push(r.timestamp, fence + 'diff', r.diff, fence, '');
        }
    }
    for (const e of [
      ...work.decisions,
      ...work.plans,
      ...(ai === 'off' ? [] : work.aiOutputs),
    ])
      lines.push(e.text, '');
    for (const e of work.toolCalls) lines.push(toolCallBlock(e), '');
  }
  return lines;
}
