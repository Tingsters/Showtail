import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { activeAuthorPaths, authorSlugs, readAuthor } from '../core/authors.ts';
import { ShowtailError } from '../core/errors.ts';
import { emitJson } from '../core/output.ts';
import { approvalCode, buildPrComment, scanComment } from '../core/prComment.ts';
import {
  buildReportData,
  renderHtml,
  renderMarkdown,
  type ReportRenderOptions,
} from '../core/report.ts';
import { sanitizeReportData } from '../core/shareReport.ts';
import {
  buildManifest,
  SUBMISSION_DIR,
  verifySubmission,
  writeSubmission,
  type SubmissionManifest,
} from '../core/submission.ts';
import { authorPaths, requirePaths, type ShowtailPaths } from '../core/storage.ts';
import { fileLink, openInDefaultApp } from '../core/terminal.ts';
import { runReport } from './report.ts';

/** Exit status when `submit` refuses because the scan found something. */
export const SUBMIT_BLOCKED = 6;

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}
/** Runs `gh`. Injectable so tests never touch the network. */
export type GhRunner = (args: string[], input?: string) => GhResult;

const realGh: GhRunner = (args, input) => {
  const bin =
    process.env.SHOWTAIL_GH && process.env.SHOWTAIL_GH.length > 0
      ? process.env.SHOWTAIL_GH
      : 'gh';
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface SubmitOptions {
  cwd?: string;
  /** Report only this author (a slug). */
  author?: string;
  /** Report the whole team. */
  team?: boolean;
  title?: string;
  /** How much of the AI's play-by-play to show (`collapsed` | `full` | `off`). */
  ai?: string | boolean;
  /** Skip the catch-up sweep of the AI tools' transcripts. */
  sync?: boolean;
  /** The project was named explicitly (a path operand), not inferred from the cwd. */
  explicitPath?: boolean;
  /** Select a project by path, trail id, or name (as `report --project`). */
  project?: string;
  json?: boolean;
  open?: boolean;
  /** Also post a summary comment on a pull request. `true` = the current branch's PR. */
  pr?: string | boolean;
  /** With `--pr`: show the exact comment and its approval code, post nothing. */
  preview?: boolean;
  /** With `--pr`: the approval code from a preview, authorising that exact text. */
  approve?: string;
  /** Test seams. */
  gh?: GhRunner;
  confirm?: (question: string) => Promise<boolean>;
  interactive?: boolean;
}

function aiMode(value: string | boolean | undefined): 'off' | 'full' | 'collapsed' {
  if (value === false || value === 'off' || value === 'none') return 'off';
  if (value === 'full' || value === 'all') return 'full';
  return 'collapsed';
}

/** Whose work to cover: explicit flag, else the active author, else the whole team. */
function chooseScope(
  paths: ReturnType<typeof requirePaths>,
  options: SubmitOptions,
): { authorSlug?: string; label: string | null } {
  if (options.team) return { label: null };
  const slugs = authorSlugs(paths);
  const slug =
    options.author ??
    activeAuthorPaths(paths)?.slug ??
    (slugs.length === 1 ? slugs[0] : undefined);
  if (!slug) return { label: null };
  return { authorSlug: slug, label: readAuthor(authorPaths(paths, slug))?.name ?? slug };
}

function describeFindings(findings: Array<{ kind: string; count: number }>): string {
  return findings.map((f) => `${f.kind} x${f.count}`).join(', ');
}

export interface SubmitOutcome {
  dir: string;
  manifest: SubmissionManifest;
  comment?: string;
  posted?: { url: string };
}

/**
 * Build the sanitised submission. Nothing is written unless the independent scan
 * comes back clean; if it does not, this throws and the folder is left untouched.
 */
export async function runSubmit(options: SubmitOptions = {}): Promise<SubmitOutcome> {
  // `--approve` posts a previously reviewed comment; it never regenerates anything.
  if (options.pr !== undefined && options.pr !== false && options.approve !== undefined) {
    return approveStored(options);
  }
  // Bring the trail up to date exactly as `report` does (resolve the project, adopt
  // pending work, catch up from transcripts, reroute), then build from that.
  let paths: ShowtailPaths | undefined;
  await runReport({
    cwd: options.cwd,
    explicitPath: options.explicitPath,
    project: options.project,
    sync: options.sync,
    prepareOnly: true,
    onPrepared: (p) => {
      paths = p;
    },
  });
  if (!paths) {
    throw new ShowtailError(
      'Showtail: could not prepare this project for submission.',
      1,
    );
  }

  const scope = chooseScope(paths, options);
  const raw = buildReportData(paths, {
    authorSlug: scope.authorSlug,
    title: options.title,
  });
  const share = sanitizeReportData(raw, paths.root);

  if (share.findings.length > 0) {
    throw new ShowtailError(
      `Showtail: not submitting. A final independent scan still found what looks like a secret ` +
        `(${describeFindings(share.findings)}). Nothing was written. ` +
        `Rotate any key you pasted into a prompt, then run \`showtail submit\` again.`,
      SUBMIT_BLOCKED,
    );
  }

  const renderOpts: ReportRenderOptions = { ai: aiMode(options.ai) };
  const html = renderHtml(share.data, renderOpts);
  const markdown = renderMarkdown(share.data, renderOpts) + '\n';

  const { dir, manifest } = writeSubmission(paths.root, {
    html,
    markdown,
    scope: scope.label,
    summary: {
      sessions: share.data.summary.sessions,
      events: share.data.summary.events,
      artifacts: share.data.summary.artifacts,
      turns: share.data.turns.length,
    },
    withheld: { total: share.withheld, byLabel: share.byLabel },
    scanFindings: 0,
  });

  const outcome: SubmitOutcome = { dir, manifest };

  if (options.pr !== undefined && options.pr !== false) {
    const comment = buildPrComment(share.data, manifest);
    const findings = scanComment(comment);
    if (findings.length > 0) {
      throw new ShowtailError(
        `Showtail: not posting. The summary comment still contains what looks like a secret ` +
          `(${describeFindings(findings)}). The report in ${SUBMISSION_DIR}/ was written; nothing was posted.`,
        SUBMIT_BLOCKED,
      );
    }
    outcome.comment = comment;
    outcome.posted = await handlePr(comment, manifest, dir, options);
  }

  report(outcome, options, paths.root);
  if (options.open) openInDefaultApp(`${dir}/report.html`);
  return outcome;
}

/** Labels for personal data, which is withheld but is not a credential to rotate. */
const PII_LABELS = new Set(['email', 'phone', 'ssn', 'credit-card']);

/**
 * True when anything that could have been a credential was withheld. Withholding keeps
 * it out of the report, but not out of the AI provider's hands: if it was a real key the
 * student pasted into a prompt, it has to be rotated.
 */
export function withheldSecrets(withheld: SubmissionManifest['withheld']): boolean {
  return Object.entries(withheld.byLabel).some(
    ([label, n]) => n > 0 && !PII_LABELS.has(label),
  );
}

function report(outcome: SubmitOutcome, options: SubmitOptions, root: string): void {
  const { dir, manifest } = outcome;
  if (options.json) {
    emitJson({
      dir,
      report: `${dir}/report.html`,
      markdown: `${dir}/report.md`,
      withheld: manifest.withheld,
      fingerprint: `sha256:${manifest.files['report.html']}`,
      keyId: manifest.keyId,
      comment: outcome.comment ?? null,
      approvalCode: outcome.comment ? approvalCode(outcome.comment) : null,
      posted: outcome.posted ?? null,
      rotateAdvice: withheldSecrets(manifest.withheld),
    });
    return;
  }
  const rel = relative(root, dir) || dir;
  console.log(`Report ready: ${fileLink(`${dir}/report.html`)}`);
  console.log(`  Folder: ${rel}/  (report.html, report.md, manifest.json, manifest.sig)`);
  console.log(
    `  Sanitised: ${manifest.withheld.total} value(s) withheld, then re-checked by an independent scan (clean).`,
  );
  console.log(`  Fingerprint: sha256:${manifest.files['report.html']}`);
  if (withheldSecrets(manifest.withheld)) {
    console.log('');
    console.log(
      'Something that looked like a key or password was removed from your report.',
    );
    console.log(
      'If it was a REAL one you pasted into a prompt, rotate it now: the AI provider',
    );
    console.log('already received it, whatever Showtail hides afterwards.');
  }
  console.log('');
  console.log('Hand in report.html as you would any assignment.');
  console.log(
    'To attach a summary to a pull request instead: showtail submit --pr --preview',
  );
}

/** Parse `owner/repo` from a pull request URL. */
export function repoFromPrUrl(url: string): string | undefined {
  const m = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url.trim());
  return m?.[1];
}

interface PrTarget {
  ref: string[];
  url: string;
  visibility: string;
}

/** Find the pull request (current branch's, or the one named) and its repo's visibility. */
function resolvePrTarget(gh: GhRunner, options: SubmitOptions): PrTarget {
  const ref = typeof options.pr === 'string' && options.pr.length > 0 ? [options.pr] : [];
  const view = gh(['pr', 'view', ...ref, '--json', 'number,url']);
  if (view.status !== 0) {
    throw new ShowtailError(
      view.status === 127
        ? 'Showtail: the GitHub CLI (`gh`) is needed for --pr. Install it from https://cli.github.com and run `gh auth login`.'
        : `Showtail: could not find a pull request (${view.stderr.trim().split('\n')[0] || 'is there one for this branch?'}). ` +
            'Open the pull request first, or pass its number or URL: showtail submit --pr <number>.',
      1,
    );
  }
  let url: string;
  try {
    url = (JSON.parse(view.stdout) as { url: string }).url;
  } catch {
    throw new ShowtailError(
      'Showtail: could not read the pull request details from `gh`.',
      1,
    );
  }
  let visibility = 'UNKNOWN';
  const repo = repoFromPrUrl(url);
  if (repo) {
    const v = gh(['repo', 'view', repo, '--json', 'visibility']);
    if (v.status === 0) {
      try {
        visibility = (
          JSON.parse(v.stdout) as { visibility: string }
        ).visibility.toUpperCase();
      } catch {
        // Treat an unreadable answer as unknown, which we warn about like public.
      }
    }
  }
  return { ref, url, visibility };
}

/** Print the exact comment and what posting it means. */
function showComment(comment: string, target: PrTarget): void {
  const publicLike = target.visibility !== 'PRIVATE' && target.visibility !== 'INTERNAL';
  console.log('');
  console.log(`This comment would be posted on ${target.url}:`);
  console.log('------------------------------------------------------------');
  console.log(comment);
  console.log('------------------------------------------------------------');
  console.log(
    publicLike
      ? `The repository is ${target.visibility === 'UNKNOWN' ? 'of unknown visibility' : 'public'}: this comment will be public and permanent (edits stay visible in its history).`
      : `The repository is ${target.visibility.toLowerCase()}: only people with access to it can read this.`,
  );
  console.log(
    'It contains only the summary above, never the full report or any raw prompts.',
  );
  console.log('');
}

function postComment(gh: GhRunner, comment: string, target: PrTarget): { url: string } {
  const post = gh(['pr', 'comment', ...target.ref, '--body-file', '-'], comment);
  if (post.status !== 0) {
    throw new ShowtailError(
      `Showtail: posting failed (${post.stderr.trim().split('\n')[0] || 'gh exited with an error'}).`,
      1,
    );
  }
  const url = post.stdout.trim().split('\n').pop() ?? target.url;
  console.log(`Posted: ${url}`);
  return { url };
}

/** The reviewed comment, kept so `--approve` posts exactly it (never a regenerated one). */
const PENDING_FILE = 'pr-preview.json';

interface PendingComment {
  comment: string;
  code: string;
  /** sha256 of report.html when the preview was made. */
  fingerprint: string;
  createdAt: string;
}

async function handlePr(
  comment: string,
  manifest: SubmissionManifest,
  dir: string,
  options: SubmitOptions,
): Promise<{ url: string } | undefined> {
  const gh = options.gh ?? realGh;
  const target = resolvePrTarget(gh, options);
  const code = approvalCode(comment);
  showComment(comment, target);

  if (options.preview) {
    const pending: PendingComment = {
      comment,
      code,
      fingerprint: manifest.files['report.html']!,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      join(dir, PENDING_FILE),
      JSON.stringify(pending, null, 2) + '\n',
      'utf8',
    );
    console.log(
      `Nothing was posted. To post exactly this text: showtail submit --pr --approve ${code}`,
    );
    return undefined;
  }

  const interactive =
    options.interactive ??
    ((process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false));
  if (!interactive) {
    throw new ShowtailError(
      'Showtail: not posting. Review the text above first: run `showtail submit --pr --preview`, ' +
        'then `showtail submit --pr --approve <code>` with the code it prints.',
      1,
    );
  }
  const approved = await (options.confirm ?? askYesNo)('Post this comment?');
  if (!approved) {
    console.log('Not posted.');
    return undefined;
  }
  return postComment(gh, comment, target);
}

/**
 * `--approve <code>`: post the text a previous `--preview` showed, and only that.
 * Nothing is regenerated, so the text cannot differ from what was reviewed; and the
 * submission it describes must still verify (an edited report voids the approval).
 */
async function approveStored(options: SubmitOptions): Promise<SubmitOutcome> {
  // Resolve the project exactly as every other command does (never from a shell cwd an
  // assistant happened to be in). `sync: false`: approving posts stored text; it does not
  // re-read transcripts or build anything.
  let resolved: ShowtailPaths | undefined;
  await runReport({
    cwd: options.cwd,
    explicitPath: options.explicitPath,
    project: options.project,
    sync: false,
    prepareOnly: true,
    onPrepared: (p) => {
      resolved = p;
    },
  });
  if (!resolved) {
    throw new ShowtailError(
      'Showtail: could not find this project to approve its preview.',
      1,
    );
  }
  const paths: ShowtailPaths = resolved;
  const dir = join(paths.root, SUBMISSION_DIR);
  const file = join(dir, PENDING_FILE);
  const refuse = (why: string): never => {
    throw new ShowtailError(`Showtail: not posting. ${why}`, 1);
  };
  if (!existsSync(file)) {
    return refuse(
      'There is no previewed comment. Run `showtail submit --pr --preview` first and review it.',
    );
  }
  let pending: PendingComment;
  try {
    pending = JSON.parse(readFileSync(file, 'utf8')) as PendingComment;
  } catch {
    return refuse(
      'The saved preview is unreadable. Run `showtail submit --pr --preview` again.',
    );
  }
  if (
    options.approve !== pending.code ||
    approvalCode(pending.comment) !== pending.code
  ) {
    return refuse(
      `That approval code is for different text than the saved preview (its code is ${pending.code}). ` +
        'Review the preview, or run `showtail submit --pr --preview` again.',
    );
  }
  const check = verifySubmission(dir);
  if (!check.ok || check.manifest?.files['report.html'] !== pending.fingerprint) {
    return refuse(
      'The report changed since you previewed this comment. Run `showtail submit --pr --preview` again.',
    );
  }
  const findings = scanComment(pending.comment);
  if (findings.length > 0) {
    throw new ShowtailError(
      `Showtail: not posting. The summary comment still contains what looks like a secret (${describeFindings(findings)}).`,
      SUBMIT_BLOCKED,
    );
  }

  const gh = options.gh ?? realGh;
  const target = resolvePrTarget(gh, options);
  showComment(pending.comment, target);
  const posted = postComment(gh, pending.comment, target);
  rmSync(file, { force: true });
  return { dir, manifest: check.manifest!, comment: pending.comment, posted };
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export interface VerifySubmissionOptions {
  dir?: string;
  cwd?: string;
  json?: boolean;
}

/** `showtail verify-submission [dir]`: check a submission's signature, hashes and text. */
export function runVerifySubmission(options: VerifySubmissionOptions = {}): void {
  const dir = options.dir ?? `${options.cwd ?? process.cwd()}/${SUBMISSION_DIR}`;
  const check = verifySubmission(dir);
  if (options.json) {
    emitJson({
      dir,
      ok: check.ok,
      problems: check.problems,
      keyId: check.manifest?.keyId ?? null,
    });
  } else if (check.ok) {
    console.log(
      `OK: ${dir} is unchanged since it was signed (key ${check.manifest?.keyId}).`,
    );
    console.log(
      'This shows the files were not edited after `showtail submit`; it cannot show who made them.',
    );
  } else {
    console.log(`NOT VERIFIED: ${dir}`);
    for (const p of check.problems) console.log(`  - ${p}`);
  }
  if (!check.ok) throw new ShowtailError('Submission did not verify.', 3);
}

// `buildManifest` is re-exported for tests that need to sign synthetic input.
export { buildManifest };
