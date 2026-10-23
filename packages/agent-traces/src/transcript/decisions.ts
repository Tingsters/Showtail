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
} from '../util/parse.ts';

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
 *
 * `nonBlocking` marks a question the AI asked without stopping (Codex's
 * `request_user_input_async`): the heading reads `**<asker> asked (non-blocking):**`,
 * which {@link isNonBlockingDecisionText} detects so the report can badge it, and an
 * unanswered question says the AI kept working instead of "no option selected".
 */
export function renderDecisionText(
  questions: DecisionQuestion[],
  asker = 'Claude',
  opts: { nonBlocking?: boolean } = {},
): string {
  const nonBlocking = opts.nonBlocking === true;
  const blocks: string[] = [];
  for (const q of questions) {
    const heading = nonBlocking ? `${asker} asked (non-blocking)` : `${asker} asked`;
    const lines: string[] = [`**${heading}:** ${q.question}`, ''];
    for (const o of q.options) {
      lines.push(o.chosen ? `- **${o.label}** ✅ _(your choice)_` : `- ${o.label}`);
    }
    if (q.custom && q.answer) {
      lines.push('', `**You typed:** ${q.answer}`);
    } else if (nonBlocking && !q.answer) {
      lines.push('', `_(${asker} kept working while waiting for your answer)_`);
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

// --- Codex non-blocking questions -------------------------------------------

/**
 * Codex's `request_user_input_async` doesn't pause the turn: the model keeps working
 * and the student's answer arrives later as a synthetic user message wrapping a JSON
 * array — `<send_user_message_question_reply>[{answer, question, questionItemId}]
 * </send_user_message_question_reply>` — which Codex steers into the running turn.
 * It fires the same `UserPromptSubmit` hook as a typed prompt, so it must be told
 * apart from one: it is the student's *answer*, not a new prompt.
 */
const ASYNC_REPLY_RE =
  /^\s*<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>\s*$/;

/** One answered question carried by a Codex non-blocking reply envelope. */
export interface AsyncQuestionReply {
  question: string;
  answer: string;
  /** The `request_user_input_async` call this answers, from `questionItemId`. */
  callId?: string;
}

/** Pull the call id out of a `questionItemId` (a JSON-encoded `[tool, callId, index]`). */
function callIdFromItemId(itemId: string | undefined): string | undefined {
  if (!itemId) return undefined;
  try {
    const parts = asArray(JSON.parse(itemId));
    const id = asString(parts?.[1]);
    if (id) return id;
  } catch {
    // Not JSON — fall through to a pattern match.
  }
  return /call_[A-Za-z0-9_-]+/.exec(itemId)?.[0];
}

/**
 * Parse a Codex non-blocking reply envelope. Returns undefined for anything else —
 * including an envelope whose body isn't the expected JSON — so the caller falls
 * back to treating the text as a normal prompt rather than dropping student input.
 */
export function parseAsyncQuestionReply(text: string): AsyncQuestionReply[] | undefined {
  const m = ASYNC_REPLY_RE.exec(text);
  if (!m) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
  const items = asArray(body);
  if (!items) return undefined;
  const out: AsyncQuestionReply[] = [];
  for (const item of items) {
    const question = asString(prop(item, 'question'));
    const answer = asString(prop(item, 'answer'));
    if (question === undefined || answer === undefined) return undefined;
    out.push({
      question,
      answer,
      callId: callIdFromItemId(asString(prop(item, 'questionItemId'))),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The call id shared by a reply's questions, used as the stable source id
 * (`codex:decision:<callId>`) so the live hook and the transcript reconcile dedupe.
 */
export function asyncReplyCallId(replies: AsyncQuestionReply[]): string | undefined {
  return replies.find((r) => r.callId)?.callId;
}

/**
 * Render a student's answer to a non-blocking question from the envelope alone (all
 * the live hook sees — the option list lives on the earlier tool call). Same heading
 * as {@link renderDecisionText} with `nonBlocking`, so it badges the same way.
 */
export function renderAsyncReplyText(
  replies: AsyncQuestionReply[],
  asker = 'Codex',
): string {
  return replies
    .map(
      (r) =>
        `**${asker} asked (non-blocking):** ${r.question}\n\n**You answered:** ${r.answer}`,
    )
    .join('\n\n');
}

/** A prompt-hook text turned into the decision it really is. */
export interface AsyncReplyDecision {
  text: string;
  /** `codex:decision:<callId>`, when the envelope named its call — dedupes against the transcript. */
  sourceId?: string;
}

/**
 * If `text` is a Codex non-blocking reply envelope, the decision to record for it —
 * never undefined for such text, so the student's answer is always kept: a parseable
 * envelope is rendered, a malformed one is preserved verbatim. Returns undefined only
 * for text that isn't an envelope (a normal prompt).
 */
export function asyncReplyDecision(text: string): AsyncReplyDecision | undefined {
  if (!/^\s*<send_user_message_question_reply>/.test(text)) return undefined;
  const replies = parseAsyncQuestionReply(text);
  if (!replies) return { text: text.trim() };
  const callId = asyncReplyCallId(replies);
  return {
    text: renderAsyncReplyText(replies),
    sourceId: callId ? `codex:decision:${callId}` : undefined,
  };
}

/**
 * The questions of a `request_user_input_async` call, from its `questions` array
 * (`[{ title, options: string[] }]`; the options may also be `{ label }` objects).
 * Both the rollout arguments and the app-server's async `agentMessage.questions`
 * carry this shape.
 */
export function asyncQuestionsFrom(questions: unknown[]): DecisionQuestion[] {
  const out: DecisionQuestion[] = [];
  for (const q of questions) {
    const question = asString(prop(q, 'title')) ?? asString(prop(q, 'question'));
    if (!question) continue;
    const options = (asArray(prop(q, 'options')) ?? [])
      .map((o) => asString(o) ?? asString(prop(o, 'label')))
      .filter((label): label is string => Boolean(label))
      .map((label) => ({ label, chosen: false }));
    out.push({ question, options, custom: false });
  }
  return out;
}

/**
 * The asked questions with the student's reply applied: the chosen option is marked
 * (or the answer flagged as typed when it matches none). Without the original ask
 * (e.g. a thread read mid-way) the reply still renders from its own question text.
 */
export function answeredAsyncQuestions(
  asked: DecisionQuestion[] | undefined,
  replies: AsyncQuestionReply[],
): DecisionQuestion[] {
  return replies.map((r) => {
    const base = asked?.find((q) => q.question === r.question);
    const q: DecisionQuestion = base
      ? { ...base, options: base.options.map((o) => ({ ...o })) }
      : { question: r.question, options: [], custom: false };
    q.answer = r.answer;
    let matched = false;
    for (const o of q.options) {
      if (o.label === r.answer) {
        o.chosen = true;
        matched = true;
      }
    }
    q.custom = !matched; // no offered option matched → the student typed their own
    return q;
  });
}

/** Whether a decision's text is a non-blocking question or its answer. */
export function isNonBlockingDecisionText(text: string): boolean {
  return /^\s*\*\*[^*\n]+ asked \(non-blocking\):\*\*/.test(text);
}
