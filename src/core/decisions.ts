/**
 * Parsing and rendering of Claude Code AskUserQuestion "decisions".
 *
 * When Claude pauses to ask the student to choose between options, the
 * transcript records the question(s) on an assistant `tool_use` line and the
 * student's answer(s) on a later user `tool_result` line. This module turns those
 * into a normalized {@link DecisionQuestion} and renders it as readable Markdown.
 * It is pure (no I/O) and depends only on the small `parse.ts` value helpers, so
 * it can be unit-tested in isolation.
 */
import {
  asArray,
  asString,
  collectToolResults,
  isObject,
  prop,
  type ToolResult,
} from './parse.ts';

/** One option the AI offered for a decision, and whether the student picked it. */
export interface DecisionOption {
  label: string;
  description?: string;
  chosen: boolean;
}

/** One question in an AskUserQuestion decision, with its options and the answer. */
export interface DecisionQuestion {
  question: string;
  header?: string;
  options: DecisionOption[];
  /** The student's answer text (a chosen label, or free-typed text). */
  answer?: string;
  /** True when the answer was typed in, matching no offered option. */
  custom: boolean;
  /** A free-text note the student attached to this question, if any. */
  note?: string;
}

/** Parse the `input` of an AskUserQuestion tool_use into structured questions. */
export function parseDecisionQuestions(input: unknown): DecisionQuestion[] {
  const questions = asArray(prop(input, 'questions'));
  if (!questions) return [];
  const out: DecisionQuestion[] = [];
  for (const q of questions) {
    const question = asString(prop(q, 'question'));
    if (!question) continue;
    const options: DecisionOption[] = [];
    for (const o of asArray(prop(q, 'options')) ?? []) {
      const label = asString(prop(o, 'label'));
      if (!label) continue;
      options.push({
        label,
        description: asString(prop(o, 'description')),
        chosen: false,
      });
    }
    out.push({ question, header: asString(prop(q, 'header')), options, custom: false });
  }
  return out;
}

/**
 * What a tool_result told us about an AskUserQuestion. `answers`/`annotations`
 * come from the line's structured `toolUseResult` (present on a normal submit,
 * keyed by question text); `blob` is the flat result string (the only source for
 * a clarify/reject result, and for older transcripts without `toolUseResult`).
 */
export interface DecisionResult {
  blob?: string;
  answers?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Collect any AskUserQuestion answers carried on a user line's tool_result blocks. */
export function collectDecisionAnswers(
  obj: unknown,
  into: Map<string, DecisionResult>,
): void {
  // The structured result sits at the line level, alongside `message`.
  const tur = prop(obj, 'toolUseResult');
  const answers = prop(tur, 'answers');
  const annotations = prop(tur, 'annotations');
  const results = new Map<string, ToolResult>();
  collectToolResults(obj, results);
  for (const [id, r] of results) {
    const rec: DecisionResult = into.get(id) ?? {};
    if (r.content) rec.blob = r.content;
    if (isObject(answers)) rec.answers = answers;
    if (isObject(annotations)) rec.annotations = annotations;
    into.set(id, rec);
  }
}

/** Clarify/reject: splits the "Questions asked:" block at each `- "…"` marker. */
const QUESTION_MARKER_SPLIT_RE = /\r?\n-\s+"/;
/** Clarify/reject: the text after `Answer:` up to a blank line or chunk end. */
const ANSWER_LINE_RE = /Answer:\s*([\s\S]*?)(?:\r?\n\s*\r?\n|$)/;

/**
 * Pull the student's answer *values* out of the result string, in question order
 * (`undefined` for an unanswered question, so later answers stay aligned). The
 * harness returns one of two shapes; we don't key on the question text (it can
 * differ slightly from the asked text), only on position:
 *
 *  - Normal submit: `Your questions have been answered: "Q"="A" selected preview:…`
 *    A preset choice carries a preview; a free-typed ("Other") answer is the same
 *    `"Q"="A"` shape without one — both are captured here.
 *  - Clarify/reject: `…Questions asked:\n- "Q"\n  Answer: A` (or `(No answer
 *    provided)`), which the normal regex can't see — so a decision answered this
 *    way would otherwise lose every answer.
 */
function parseAnswerValues(blob: string): (string | undefined)[] {
  // Normal submit: each `"Q"="A"` pair (preset choices carry a preview; a
  // free-typed "Other" answer is the same shape without one). A fresh `/g` regex
  // per call avoids any shared `lastIndex` state. (Known minor edge: a custom
  // answer containing a literal `"` truncates at that quote.)
  const normal: (string | undefined)[] = [];
  const pairRe = /"[^"]*"\s*=\s*"([^"]*)"(?=\s+selected preview|\s*[,.]|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(blob)) !== null) normal.push(m[1]!);
  if (normal.length > 0) return normal;

  // Clarify/reject: split at each `- "…"` question marker and read its answer.
  const idx = blob.indexOf('Questions asked:');
  if (idx < 0) return [];
  return blob
    .slice(idx)
    .split(QUESTION_MARKER_SPLIT_RE)
    .slice(1) // drop the `Questions asked:` preamble before the first marker
    .map((chunk) => {
      // `(No answer provided)` has no `Answer:` and stays undefined.
      const am = ANSWER_LINE_RE.exec(chunk);
      const a = am?.[1]?.trim();
      return a ? a : undefined;
    });
}

/** A result value meaning the student picked nothing (e.g. left only a note). */
function isNoSelection(answer: string | undefined): boolean {
  return (
    answer === undefined || answer === '(notes only)' || answer === '(No answer provided)'
  );
}

/**
 * Fill in, per question, the note the student attached and which option they
 * chose (or flag a typed answer). Prefers the structured `toolUseResult` (keyed
 * by question text, and the only place notes live); falls back to the positional
 * flat-string parser for clarify/reject results and older transcripts.
 */
export function resolveDecisionAnswers(
  questions: DecisionQuestion[],
  rec: DecisionResult,
): void {
  const structured = rec.answers !== undefined;
  const positional = structured ? [] : parseAnswerValues(rec.blob ?? '');
  questions.forEach((q, i) => {
    // Notes only ever arrive structured; capture before anything else.
    const note = asString(prop(rec.annotations?.[q.question], 'notes'));
    if (note) q.note = note;

    const answer = structured ? asString(rec.answers?.[q.question]) : positional[i];
    if (isNoSelection(answer)) return;
    q.answer = answer;
    // multiSelect answers are comma-joined labels; single answers match one label.
    const picked = answer!.split(/,\s*/);
    let matched = false;
    for (const o of q.options) {
      if (o.label === answer || picked.includes(o.label)) {
        o.chosen = true;
        matched = true;
      }
    }
    q.custom = !matched; // no option matched → the student typed their own answer
  });
}

/**
 * Render a decision as readable Markdown: the question, every option, the choice.
 * `asker` names the AI that paused to ask (defaults to Claude; Codex passes its
 * own name) so the rendered text reads `**<asker> asked:** …`.
 */
export function renderDecisionText(
  questions: DecisionQuestion[],
  asker = 'Claude',
): string {
  const blocks: string[] = [];
  for (const q of questions) {
    const lines: string[] = [`**${asker} asked:** ${q.question}`, ''];
    for (const o of q.options) {
      lines.push(o.chosen ? `- **${o.label}** ✅ _(your choice)_` : `- ${o.label}`);
    }
    if (q.custom && q.answer) {
      lines.push('', `**You typed:** ${q.answer}`);
    } else if (!q.options.some((o) => o.chosen)) {
      // No preset chosen and nothing typed — the student was asked but didn't pick
      // (e.g. they clarified instead). Say so rather than leaving it ambiguous.
      lines.push('', '_(no option selected)_');
    }
    // A free-text note the student left, whether or not they also picked an option.
    if (q.note) lines.push('', `**Your note:** ${q.note}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
