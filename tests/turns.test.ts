import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, renderHtml } from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('turns', () => {
  test('groups a prompt with its AI output and code change by turnId', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);

      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      await logEvent(paths, {
        type: 'ai_output',
        text: 'Here is a hello function.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      writeFileSync(join(dir, 'hello.ts'), 'export const hello = () => "hi";');
      await addArtifact(paths, {
        filePath: 'hello.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        diff: '+ export const hello = () => "hi";',
      });

      const data = buildReportData(paths);
      expect(data.turns).toHaveLength(1);
      const turn = data.turns[0]!;
      expect(turn.prompt.text).toBe('add a hello function');
      expect(turn.aiOutputs).toHaveLength(1);
      expect(turn.codeChanges).toHaveLength(1);
      expect(turn.codeChanges[0]!.diff).toContain('export const hello');
    } finally {
      cleanup(dir);
    }
  });

  test('falls back to timestamp adjacency when turnId is absent', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);

      await logEvent(paths, { type: 'prompt', text: 'first prompt', tool: 'chatgpt' });
      await logEvent(paths, {
        type: 'ai_output',
        text: 'an answer with no turn id',
        tool: 'chatgpt',
      });

      const data = buildReportData(paths);
      expect(data.turns).toHaveLength(1);
      expect(data.turns[0]!.aiOutputs).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('renders fenced code in an AI response as a monospace code box', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);
      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'hello world in python',
        tool: 'chatgpt',
      });
      await logEvent(paths, {
        type: 'ai_output',
        text: 'Here you go:\n```python\nprint("Hello, world!")\n```\nRun with `python hi.py`.',
        tool: 'chatgpt',
        turnId: prompt.id,
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('<pre class="codeblock">');
      expect(html).toContain('class="code-lang"'); // language label
      expect(html).toContain('Hello, world!'); // string still present
      expect(html).toContain('class="tok-'); // syntax highlighting applied
      expect(html).toContain('<code>python hi.py</code>'); // inline code
      expect(html).not.toContain('```'); // no literal fences left
      expect(html).not.toContain('<script>');
    } finally {
      cleanup(dir);
    }
  });

  test('renders Markdown in an AI response (bold/heading/list/link), no raw marks', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);
      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'explain',
        tool: 'chatgpt',
      });
      await logEvent(paths, {
        type: 'ai_output',
        text:
          '## Steps\nUse **bold** and *italic*.\n- one\n- two\n\nSee [docs](https://example.com).\n' +
          'Avoid [evil](javascript:alert(1)).',
        tool: 'chatgpt',
        turnId: prompt.id,
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
      expect(html).toContain('<div class="md-h">Steps</div>');
      expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
      expect(html).toContain('<a href="https://example.com"');
      expect(html).not.toContain('**bold**'); // no raw marks left
      expect(html).not.toContain('<h4>AI response</h4>'); // redundant label dropped
      // javascript: link is not turned into an anchor
      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain('<script>');
    } finally {
      cleanup(dir);
    }
  });

  test('renders collapsible <details> cards with diff coloring and no <script>', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      startSession(paths);
      const { event: prompt } = await logEvent(paths, {
        type: 'prompt',
        text: 'write a test',
        tool: 'claude-code',
      });
      writeFileSync(join(dir, 'a.ts'), 'const a = 2;');
      await addArtifact(paths, {
        filePath: 'a.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        diff: '- const a = 1;\n+ const a = 2;',
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('<details class="turn">');
      expect(html).toContain('class="badge"');
      // Each changed line is a single .dline block with a +/- gutter (.dmark).
      expect(html).toContain('class="dline del"');
      expect(html).toContain('class="dline add"');
      expect(html).toContain('class="dmark"');
      // Code inside the diff is syntax-highlighted with the shared tok-* theme.
      expect(html).toContain('class="tok-kw"');
      // Rows are adjacent — no empty (gray-gap) line is emitted between them.
      expect(html).toContain('</span><span class="dline');
      // A Close button collapses the card; inline handler, not a <script>.
      expect(html).toContain('class="turn-close"');
      expect(html).toContain('open=false');
      expect(html).not.toContain('<script>');
    } finally {
      cleanup(dir);
    }
  });
});
