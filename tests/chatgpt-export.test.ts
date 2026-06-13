import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { importConversation, parseExportJson } from '../src/core/chatgpt.ts';
import { readAllEvents } from '../src/core/events.ts';
import { runInit } from '../src/commands/init.ts';
import { runImportChatgptExport } from '../src/commands/import.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

type Turn = [role: string, text: string, id: string, createTime: number];

/** Build an export-format conversation object (a `mapping` node graph). */
function exportConvo(id: string, title: string, createTime: number, turns: Turn[]) {
  const mapping: Record<string, any> = {
    root: { id: 'root', message: null, parent: null, children: [] },
  };
  let prev = 'root';
  for (const [role, text, mid, ct] of turns) {
    mapping[mid] = {
      id: mid,
      message: {
        id: mid,
        author: { role, metadata: {} },
        content: { content_type: 'text', parts: [text] },
        create_time: ct,
        metadata: {},
      },
      parent: prev,
      children: [],
    };
    mapping[prev].children = [mid];
    prev = mid;
  }
  return { id, conversation_id: id, title, create_time: createTime, mapping };
}

function exportJson() {
  return JSON.stringify([
    exportConvo('a', 'Recursive parser help', 1_781_481_600, [
      ['user', 'How do I write a recursive descent parser?', 'a-u1', 1_781_481_660],
      ['assistant', 'Start with a tokenizer.', 'a-a1', 1_781_481_720],
    ]),
    exportConvo('b', 'Weekend plans', 1_690_000_000, [
      ['user', 'Ideas for the weekend?', 'b-u1', 1_690_000_060],
    ]),
  ]);
}

describe('chatgpt export import', () => {
  test('parseExportJson reconstructs conversations from the mapping graph', () => {
    const convos = parseExportJson(exportJson());
    expect(convos).toHaveLength(2);
    const a = convos.find((c) => c.id === 'a')!;
    expect(a.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(a.messages[0]!.text).toContain('recursive descent');
  });

  test('--all imports prompts from every conversation, tagged chatgpt', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'conversations.json');
      writeFileSync(file, exportJson(), 'utf8');

      await runImportChatgptExport(file, { all: true, cwd: dir });
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(2); // a-u1 + b-u1
      expect(prompts.every((e) => e.tool === 'chatgpt')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('--match filters by title; --since filters by date', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'conversations.json');
      writeFileSync(file, exportJson(), 'utf8');

      await runImportChatgptExport(file, { match: 'parser', cwd: dir });
      let prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.text).toContain('recursive descent');
    } finally {
      cleanup(dir);
    }
  });

  test('--since keeps only recent conversations', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'conversations.json');
      writeFileSync(file, exportJson(), 'utf8');

      await runImportChatgptExport(file, { since: '2026-01-01', cwd: dir });
      const prompts = readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt');
      expect(prompts).toHaveLength(1); // only the 2026 conversation 'a'
      expect(prompts[0]!.sourceId).toBe('a-u1');
    } finally {
      cleanup(dir);
    }
  });

  test('--list imports nothing', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'conversations.json');
      writeFileSync(file, exportJson(), 'utf8');

      await runImportChatgptExport(file, { list: true, cwd: dir });
      expect(readAllEvents(pathsForRoot(dir))).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  test('no filter and no --all refuses to bulk-import the whole history', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const file = join(dir, 'conversations.json');
      writeFileSync(file, exportJson(), 'utf8');
      await expect(runImportChatgptExport(file, { cwd: dir })).rejects.toThrow(
        /whole history|--all|narrow/i,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('reads conversations.json out of an export .zip', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const zipPath = join(dir, 'export.zip');
      const zipped = zipSync({ 'conversations.json': strToU8(exportJson()) });
      writeFileSync(zipPath, zipped);

      await runImportChatgptExport(zipPath, { all: true, cwd: dir });
      expect(
        readAllEvents(pathsForRoot(dir)).filter((e) => e.type === 'prompt'),
      ).toHaveLength(2);
    } finally {
      cleanup(dir);
    }
  });

  test('export import dedupes against an already-imported conversation', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const convoA = parseExportJson(exportJson()).find((c) => c.id === 'a')!;

      const first = await importConversation(paths, convoA);
      expect(first.prompts).toBe(1);
      const again = await importConversation(paths, convoA);
      expect(again.prompts).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);
    } finally {
      cleanup(dir);
    }
  });
});
