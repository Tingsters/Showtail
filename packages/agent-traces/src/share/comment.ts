/**
 * Helpers for posting text to a public place (a PR body or comment) safely: defuse
 * mentions and HTML, scan for leftover secrets, and tie posting to an approved preview.
 */
import { createHash } from 'node:crypto';
import { scanResidual, type Finding } from '../privacy/sanitize.ts';

/** Keep a user's text from pinging people, linking issues, or injecting HTML. */
export function neutralize(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@​')
    .replace(/#(\d)/g, '#​$1')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Findings from scanning a comment body; any finding means it must not be posted. */
export function scanComment(body: string): Finding[] {
  // A fingerprint line is a 64-hex hash by design: scan with it removed.
  const withoutHash = body.replace(/`sha256:[0-9a-f]{64}`/g, '');
  return scanResidual(withoutHash);
}

/**
 * A short code that identifies this exact text. The user approves a preview, and
 * posting requires the code for *that* text, so an agent (or a script) cannot post
 * something other than what was reviewed.
 */
export function approvalCode(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 8);
}
