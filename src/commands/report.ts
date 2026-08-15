import { join } from 'node:path';
import {
  type AiMode,
  buildReportData,
  renderHtml,
  renderMarkdown,
  type ReportRenderOptions,
} from '../core/report.ts';
import {
  activeAuthorPaths,
  authorSlugs,
  readAuthor,
  upgradeIdentityIfProvisional,
} from '../core/authors.ts';
import { catchUpFromTranscripts } from '../core/catchUp.ts';
import { emitJson } from '../core/output.ts';
import { authorPaths, requirePaths, writeJson } from '../core/storage.ts';
import { fileLink, openInDefaultApp } from '../core/terminal.ts';
import { readAutoOpenReport, setAutoOpenReport } from '../core/globalConfig.ts';
import { type OpenableReport, promptOpenReport } from '../core/prompt.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ReportData } from '../types.ts';

export interface ReportOptions {
  format?: string;
  cwd?: string;
  /** Open the generated report in the OS default app after writing it. */
  open?: boolean;
  /** Generate only this author's report (slugified email). */
  author?: string;
  /** Generate only the combined team report. */
  team?: boolean;
  /** Override the descriptive name shown in the title (beats the project name). */
  title?: string;
  /**
   * How much of the AI's play-by-play to show: `collapsed` (default, behind a
   * disclosure), `full` (expanded), or `off` (omitted). Commander sets `false`
   * for `--no-ai` (which we treat as `off`) and defaults it to `true` otherwise.
   */
  ai?: string | boolean;
  /** Emit machine-readable JSON (the written paths + summary) instead of prose. */
  json?: boolean;
  /** Force the open menu this run, ignoring a remembered choice (from `--ask`). */
  ask?: boolean;
  /**
   * Skip the catch-up sweep of the AI tools' own transcripts. Commander sets
   * this `false` for `--no-sync`. The sweep is on by default because a host
   * writes its transcript asynchronously and appends its end-of-turn recap
   * minutes after the last hook ran — so without it a report can be missing the
   * final exchange of a session (see `src/core/catchUp.ts`).
   */
  sync?: boolean;
}

/** Normalize the `--ai` flag (and `--no-ai` → false) to a render mode. */
function aiMode(value: string | boolean | undefined): AiMode {
  if (value === false || value === 'off' || value === 'none') return 'off';
  if (value === 'full' || value === 'all') return 'full';
  return 'collapsed';
}

/** A filesystem-safe timestamp for report filenames, e.g. 2026-06-12T140300. */
function fileStamp(iso: string): string {
  return iso.replace(/:/g, '').replace(/\..+$/, '');
}

/** One report to generate: a filename key, a human label, and the builder scope. */
interface ReportTarget {
  key: string;
  label: string;
  scope: { authorSlug?: string };
}

/** A written report's primary file plus its Markdown source (if any). */
interface WrittenReport {
  key: string;
  label: string;
  format: string;
  reportPath: string;
  markdownPath: string | null;
}

/** A contributor target keyed by slug, labelled with their display name. */
function authorTarget(
  paths: ReturnType<typeof requirePaths>,
  slug: string,
): ReportTarget {
  const label = readAuthor(authorPaths(paths, slug))?.name ?? slug;
  return { key: slug, label, scope: { authorSlug: slug } };
}

/**
 * Decide which reports to write. `--author`/`--team` are explicit. By default:
 * with two or more contributors, the combined team report first, then one each;
 * with a single contributor there is no "team" — just their report; with none,
 * a single default report.
 */
export function reportTargets(
  paths: ReturnType<typeof requirePaths>,
  options: ReportOptions,
  slugs: string[],
): ReportTarget[] {
  if (options.author) {
    return [authorTarget(paths, options.author)];
  }
  if (options.team) {
    return [{ key: 'team', label: 'team', scope: {} }];
  }
  if (slugs.length >= 2) {
    return [
      { key: 'team', label: 'team', scope: {} },
      ...slugs.map((s) => authorTarget(paths, s)),
    ];
  }
  if (slugs.length === 1) {
    return [authorTarget(paths, slugs[0]!)];
  }
  return [{ key: 'team', label: 'team', scope: {} }];
}

/**
 * Generate reports under `.showtail/reports/` and print where they were written.
 * In a multi-student project this writes a combined team report plus one report
 * per contributor by default; `--author <slug>` or `--team` narrows that. HTML
 * by default; the Markdown it renders from is written alongside as the source of
 * truth, and `--format md`/`--format json` switch the primary output. `--json`
 * emits the written paths + summary for an agent instead of prose.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  const paths = requirePaths(options.cwd);
  // Turn-in checkpoint: if capture has been under a computer-derived placeholder, adopt
  // the student's real identity (gh/git/env) now and re-attribute the work, so the report
  // is under their real name even if they never made a git commit. Best-effort, silent.
  await upgradeIdentityIfProvisional(paths, { cwd: options.cwd ?? process.cwd() });
  // Complete the trail before reading it: hosts write their transcripts
  // asynchronously and append the end-of-turn recap after every hook has run, so
  // the last exchange of a session only becomes visible on a later re-read.
  // Best-effort and idempotent — see `src/core/catchUp.ts`.
  if (options.sync !== false) {
    try {
      const active = activeAuthorPaths(paths);
      if (active) await catchUpFromTranscripts(active);
    } catch {
      // Never block a report on the sweep; the trail is still fully readable.
    }
  }
  const slugs = authorSlugs(paths);
  const stamp = fileStamp(new Date().toISOString());
  mkdirSync(paths.reportsDir, { recursive: true });

  const targets = reportTargets(paths, options, slugs);
  const written: WrittenReport[] = [];
  let teamData: ReportData | undefined;

  for (const target of targets) {
    const data = buildReportData(paths, { ...target.scope, title: options.title });
    if (target.key === 'team') teamData = data;
    written.push(writeOneReport(paths.reportsDir, target, stamp, data, options));
  }

  const primary = written[0];
  const summarySource = teamData ?? (await firstData(paths, targets));

  if (options.json) {
    if (options.open && primary) openInDefaultApp(primary.reportPath);
    emitJson({
      format: options.format ?? 'html',
      reportPath: primary?.reportPath ?? null,
      markdownPath: primary?.markdownPath ?? null,
      summary: summarySource?.summary ?? null,
      reports: written,
    });
    return;
  }

  if (summarySource) {
    console.log('');
    console.log(
      `Summary: ${summarySource.summary.sessions} session(s), ` +
        `${summarySource.summary.events} event(s), ` +
        `${summarySource.summary.artifacts} artifact record(s)` +
        (summarySource.contributors.length > 1
          ? `, ${summarySource.contributors.length} contributor(s)`
          : '') +
        '.',
    );
  }

  if (primary) await offerToOpen(written, primary, options);
}

/** Write one report in the requested format; return its written paths. */
function writeOneReport(
  reportsDir: string,
  target: ReportTarget,
  stamp: string,
  data: ReportData,
  options: ReportOptions,
): WrittenReport {
  const { key, label } = target;
  const base = `report-${key}-${stamp}`;
  const format = options.format ?? 'html';
  const quiet = options.json === true;
  const renderOpts: ReportRenderOptions = { ai: aiMode(options.ai) };
  // The printed link's text is the full path: the click target where the terminal
  // renders OSC 8 hyperlinks, and — everywhere else — the location itself, so it can
  // be read and copied. A basename alone says nothing about where the file landed.
  const link = (out: string) => fileLink(out);

  if (format === 'json') {
    const out = join(reportsDir, `${base}.json`);
    writeJson(out, data);
    if (!quiet) console.log(`Wrote JSON report (${key}): ${link(out)}`);
    return { key, label, format, reportPath: out, markdownPath: null };
  }

  // The Markdown is always written: on its own for `--format md`, and as the
  // source the HTML is rendered from otherwise.
  const mdOut = join(reportsDir, `${base}.md`);
  writeFileSync(mdOut, renderMarkdown(data, renderOpts) + '\n', 'utf8');

  if (format === 'md') {
    if (!quiet) console.log(`Wrote report (${key}): ${link(mdOut)}`);
    return { key, label, format, reportPath: mdOut, markdownPath: null };
  }
  const htmlOut = join(reportsDir, `${base}.html`);
  writeFileSync(htmlOut, renderHtml(data, renderOpts), 'utf8');
  if (!quiet) console.log(`Wrote report (${key}): ${link(htmlOut)}`);
  return { key, label, format, reportPath: htmlOut, markdownPath: mdOut };
}

/** Fallback summary source when no team report was generated (e.g. `--author`). */
async function firstData(
  paths: ReturnType<typeof requirePaths>,
  targets: ReportTarget[],
): Promise<ReportData | undefined> {
  const first = targets[0];
  if (!first) return undefined;
  return buildReportData(paths, first.scope);
}

/**
 * Decide what to do about opening the report, without side effects (testable):
 * honour `--open`/`--no-open`/`--json` first, never touch a non-interactive run,
 * then apply the remembered preference, falling back to prompting.
 */
export function resolveOpenAction(
  opts: { open?: boolean; json?: boolean; ask?: boolean },
  pref: 'always' | 'never' | 'ask',
  interactive: boolean,
): 'open' | 'skip' | 'ask' {
  if (opts.open === true) return 'open'; // --open: open the primary report once
  if (opts.open === false) return 'skip'; // --no-open
  if (opts.json) return 'skip';
  if (!interactive) return 'skip'; // piped/CI/agent: never auto-open, never prompt
  if (opts.ask) return 'ask'; // --ask: show the menu even if a choice is remembered
  if (pref === 'always') return 'open';
  if (pref === 'never') return 'skip';
  return 'ask';
}

/**
 * After writing, open the report per the resolved action: launch it directly, or
 * show the once/always/never menu and act on (and remember) the choice.
 */
async function offerToOpen(
  written: WrittenReport[],
  primary: WrittenReport,
  options: ReportOptions,
): Promise<void> {
  const interactive = (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
  const action = resolveOpenAction(options, readAutoOpenReport(), interactive);
  if (action === 'skip') return;
  if (action === 'open') {
    openInDefaultApp(primary.reportPath);
    return;
  }
  const openable: OpenableReport[] = written.map((w) => ({
    label: w.label,
    path: w.reportPath,
  }));
  const choice = await promptOpenReport(openable, {
    label: primary.label,
    path: primary.reportPath,
  });
  if (choice.kind === 'open') openInDefaultApp(choice.path);
  else if (choice.kind === 'always') {
    setAutoOpenReport('always');
    openInDefaultApp(primary.reportPath);
  } else if (choice.kind === 'never') setAutoOpenReport('never');
}
