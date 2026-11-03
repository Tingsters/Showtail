import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript } from '../src/core/claudeCode.ts';
import { readClaudeSource } from '../src/core/nativeSourceCursor.ts';
import { isSyntheticPrompt } from '../src/core/syntheticPrompt.ts';
import { fixture } from './centralHelpers.ts';

const marker = '[Request interrupted by user]';

test('only the exact native interruption marker is classified as synthetic', () => {
  expect(isSyntheticPrompt(marker)).toBe(true);
  expect(isSyntheticPrompt(` \n${marker}\n `)).toBe(true);
  for (const text of [
    `Explain ${marker} in the transcript.`,
    `"${marker}"`,
    `${marker} appears after I press Escape.`,
    `${marker}\nWhat does this mean?`,
  ])
    expect(isSyntheticPrompt(text)).toBe(false);
});

test('Claude drops host interruption bookkeeping while preserving human mentions and explicit human text', () =>
  fixture(({ project }) => {
    const frame = (uuid: string, text: string) => ({
      type: 'user',
      uuid,
      sessionId: 'interrupted-thread',
      timestamp: '2026-11-03T02:26:21.112Z',
      cwd: project,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    const rows = [
      { ...frame('initial', 'Create the requested file.'), promptSource: 'sdk' },
      frame('native-interrupt', marker),
      frame('natural-mention', `Explain ${marker} in the transcript.`),
      { ...frame('explicit-human', marker), origin: { kind: 'human' } },
    ];
    const parsed = parseClaudeTranscript(
      rows.map((row) => JSON.stringify(row)).join('\n'),
      project,
    );
    expect(
      parsed.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.sourceId),
    ).toEqual(['initial', 'natural-mention', 'explicit-human']);
  }));

test('Claude append cursors keep the opening prompt when a turn ends with an interruption marker', () =>
  fixture(({ dir, project }) => {
    const initial =
      JSON.stringify({
        type: 'user',
        uuid: 'initial',
        promptSource: 'sdk',
        timestamp: '2026-11-03T02:26:18.007Z',
        cwd: project,
        message: { role: 'user', content: 'Create resumed.txt containing resumed.' },
      }) + '\n';
    const interrupted =
      JSON.stringify({
        type: 'user',
        uuid: 'native-interrupt',
        timestamp: '2026-11-03T02:26:21.112Z',
        cwd: project,
        message: { role: 'user', content: [{ type: 'text', text: marker }] },
      }) + '\n';
    const path = join(dir, 'interrupted.jsonl');
    writeFileSync(path, initial + interrupted);
    const first = readClaudeSource(path);
    expect(readClaudeSource(path, first.checkpoint).content).toContain(
      '"uuid":"initial"',
    );
    // Version 1 could checkpoint this provider marker as a new human turn.
    const legacy = {
      ...JSON.parse(first.checkpoint),
      version: 1,
      offset: Buffer.byteLength(initial),
    };
    expect(readClaudeSource(path, JSON.stringify(legacy)).content).toContain(
      '"uuid":"initial"',
    );
    expect(readFileSync(path, 'utf8')).toBe(initial + interrupted);
  }));
