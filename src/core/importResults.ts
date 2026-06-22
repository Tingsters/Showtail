/**
 * Shared result printing for the share/paste importers (ChatGPT, Gemini). Both
 * report the same thing after `importConversation`, differing only in the tool
 * id, the assistant's name in the role-marker hint, and the provider whose
 * servers host a share link. Claude Code's importer reports a different shape
 * (edits/decisions, multi-session) and is not covered here.
 */
import { readAllEvents } from './events.ts';
import type { ImportResult } from './importCommon.ts';
import type { ShowtailPaths } from './storage.ts';
import { oneLine } from './text.ts';

export interface ImportPrintConfig {
  /** Tool id events were tagged with, shown as "(tool: …)". */
  tool: string;
  /** Assistant's display name in the "You said:/<X> said:" hint. */
  assistantLabel: string;
  /** Provider whose servers host the share link, for the privacy note. */
  privacyOrg: string;
}

/** Print the result of a share-link/file import. */
export function printShareResult(
  res: ImportResult,
  withResponses: boolean,
  cfg: ImportPrintConfig,
): void {
  const totalNew = res.prompts + res.responses;
  if (totalNew === 0) {
    if (res.skipped > 0) {
      console.log(
        `Already imported "${res.title}" — nothing new (${res.skipped} message(s) already in your trail).`,
      );
    } else {
      console.log(`No prompts found in "${res.title}".`);
    }
  } else {
    const parts = [`${res.prompts} prompt(s)`];
    if (withResponses) parts.push(`${res.responses} response(s)`);
    console.log(`Imported from "${res.title}": ${parts.join(', ')} (tool: ${cfg.tool}).`);
    if (res.skipped) console.log(`  ${res.skipped} already-imported message(s) skipped.`);
    if (res.first && res.last) console.log(`  Spanned ${res.first} → ${res.last}.`);
  }
  console.log('');
  console.log('Run `showtail report` to see it interleaved with your other tools.');
  console.log(
    `Privacy: a share link is public on ${cfg.privacyOrg}’s servers — delete it once imported.`,
  );
}

/** Print the result of a pasted-transcript import (with a skim of what was recorded). */
export function printPasteResult(
  paths: ShowtailPaths,
  batchId: string,
  res: ImportResult,
  markersFound: boolean,
  withResponses: boolean,
  cfg: ImportPrintConfig,
): void {
  const recorded = readAllEvents(paths).filter(
    (e) => e.batchId === batchId && e.type === 'prompt',
  );

  if (res.prompts + res.responses === 0) {
    console.log(
      res.skipped > 0
        ? `Already imported — nothing new (${res.skipped} message(s) already in your trail).`
        : 'Nothing new to import.',
    );
    return;
  }

  const parts = [`${res.prompts} prompt(s)`];
  if (withResponses && res.responses > 0) parts.push(`${res.responses} response(s)`);
  console.log(`Recorded ${parts.join(' and ')} from your paste (tool: ${cfg.tool}).`);

  if (!markersFound) {
    console.log('');
    console.log(
      `No 'You said:/${cfg.assistantLabel} said:' markers were in your paste, so I recorded everything`,
    );
    console.log(
      `as YOUR prompts. If any of it was ${cfg.assistantLabel}'s reply, undo below and re-copy with those`,
    );
    console.log('markers — or use the share link, which separates them exactly.');
  }

  console.log('');
  console.log('Here’s what I recorded — skim it:');
  recorded.forEach((e, i) => console.log(`  ${i + 1}. ${oneLine(e.text)}`));
  if (res.skipped) console.log(`  (${res.skipped} already-imported message(s) skipped.)`);

  console.log('');
  console.log('Not yours? Undo this whole batch:  showtail import undo');
  console.log('Looks right? Run `showtail report` to see it under “Prompts used”.');
}
