import type { ReportData, Turn } from '../../types.ts';
import { toolLabel } from './data.ts';
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
