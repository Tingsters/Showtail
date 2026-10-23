/**
 * Time and sequence matching for tying a session log to other evidence
 * (a recorded session, a range of commits). Clocks drift and logs are written a
 * little before or after the work, so every comparison takes an allowed drift.
 */
import type { HookTranscript } from '../model.ts';

/** Milliseconds since the epoch for an ISO timestamp, or undefined if unparseable. */
export function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether two timestamps are within `driftMs` of each other. When either is missing
 * there is no evidence against a match, so this returns true.
 */
export function closeInTime(
  a: string | undefined,
  b: string | undefined,
  driftMs: number,
): boolean {
  const left = timestampMs(a);
  const right = timestampMs(b);
  return left !== undefined && right !== undefined
    ? Math.abs(left - right) <= driftMs
    : true;
}

/** The earliest and latest timestamp across a transcript's messages and events. */
export function transcriptSpan(transcript: HookTranscript): {
  first?: string;
  last?: string;
} {
  let first: string | undefined;
  let last: string | undefined;
  for (const item of [...transcript.messages, ...(transcript.events ?? [])]) {
    const ts = item.timestamp;
    if (!ts) continue;
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;
  }
  return { first, last };
}

/** A time range; a missing end means a single instant at `start`. */
export interface Span {
  start?: string;
  end?: string;
}

/** Whether two spans overlap once each is widened by `driftMs`. False if either lacks a start. */
export function spansOverlap(a: Span, b: Span, driftMs: number): boolean {
  const aStart = timestampMs(a.start);
  const aEnd = timestampMs(a.end) ?? aStart;
  const bStart = timestampMs(b.start);
  const bEnd = timestampMs(b.end) ?? bStart;
  if (
    aStart === undefined ||
    aEnd === undefined ||
    bStart === undefined ||
    bEnd === undefined
  ) {
    return false;
  }
  return bStart <= aEnd + driftMs && bEnd >= aStart - driftMs;
}

/** Whether `needles` appears, in order and unbroken, somewhere in `haystack`. */
export function isContiguousSubsequence(needles: string[], haystack: string[]): boolean {
  if (needles.length === 0 || needles.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needles.length; start += 1) {
    for (let i = 0; i < needles.length; i += 1) {
      if (needles[i] !== haystack[start + i]) continue outer;
    }
    return true;
  }
  return false;
}
