import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  markdownToHtml,
  renderHtml,
  renderMarkdown,
  renderRichText,
} from '../src/core/report.ts';
import { cleanup, makeTempDir, readJsonReport } from './helpers.ts';
describe('report', () => {
  test('markdownToHtml converts the supported Markdown subset', () => {
    expect(markdownToHtml('## Heading')).toContain('<h2>Heading</h2>');
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>');
    expect(markdownToHtml('- one\n- two')).toContain('<ul>');
    expect(markdownToHtml('- one')).toContain('<li>one</li>');
    expect(markdownToHtml('a **bold** word')).toContain('<strong>bold</strong>');
    expect(markdownToHtml('a `code` word')).toContain('<code>code</code>');
    expect(markdownToHtml('_quiet_')).toContain('<em>quiet</em>');
    expect(markdownToHtml('> a quote')).toContain('<blockquote>a quote</blockquote>');
  });
  describe('renderRichText (card bodies, e.g. plan cards)', () => {
    test('coalesces a multi-line blockquote into a single box', () => {
      const html = renderRichText('> line one\n> line two');
      expect(html.match(/<blockquote/g)?.length).toBe(1);
      expect(html).toContain('line one');
      expect(html).toContain('line two');
    });
    test('renders a GitHub callout with a label, not the raw marker', () => {
      const html = renderRichText('> [!NOTE]\n> Heads up.');
      expect(html).toContain('class="callout callout-note"');
      expect(html).toContain('<p class="callout-label">Note</p>');
      expect(html).toContain('Heads up.');
      expect(html).not.toContain('[!NOTE]');
    });
    test('renders a list inside a blockquote as real list items', () => {
      const html = renderRichText('> - first\n> - second');
      expect(html).toContain('<blockquote>');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>first</li>');
      expect(html).toContain('<li>second</li>');
    });
    test('nests an indented sub-list inside its parent item', () => {
      const html = renderRichText('- outer\n  - inner');
      // The nested <ul> lives inside the outer <li>, before its </li>.
      expect(html).toContain('<li>outer<ul><li>inner</li></ul></li>');
    });
    test('keeps an indented continuation inside its list item', () => {
      const html = renderRichText('1. Step one\n   more about step one\n2. Step two');
      // One list — the continuation used to split it in two and strand the text.
      expect((html.match(/<ol/g) || []).length).toBe(1);
      expect(html).toContain('<li>Step one<p>more about step one</p></li>');
      expect(html).toContain('<li>Step two</li>');
    });
    test('keeps a continuation paragraph after a blank line in its item', () => {
      const html = renderRichText(
        '- **Point one**\n\n  A second paragraph elaborating.\n\n- **Point two**',
      );
      expect((html.match(/<ul/g) || []).length).toBe(1);
      expect(html).toContain(
        '<li><strong>Point one</strong><p>A second paragraph elaborating.</p></li>',
      );
    });
    test('an unindented paragraph after a list still ends the list', () => {
      // The guard for the change above: a blank line no longer closes a list, so
      // what follows has to decide, and unindented prose must still break out.
      const html = renderRichText('- a\n- b\n\nA separate paragraph.');
      expect(html).toBe('<ul><li>a</li><li>b</li></ul><p>A separate paragraph.</p>');
    });
    test('keeps a fenced block inside the blockquote that contains it', () => {
      const html = renderRichText(
        '> Run the installer first:\n> ```bash\n> npm install\n> ```\n> Then start the server.',
      );
      // One quote, not two with the code stranded between them.
      expect((html.match(/<blockquote>/g) || []).length).toBe(1);
      expect(html).toContain('<blockquote><p>Run the installer first:</p>');
      expect(html).toContain('Then start the server.</p></blockquote>');
      // The quote markers must not end up inside the code a reader copies.
      expect(html).toContain('<code>npm install</code>');
      expect(html).not.toContain('&gt; npm install');
    });
    test('attaches a fenced block to the list item it documents', () => {
      const html = renderRichText(
        '1. Install it:\n   ```bash\n   npm install\n   ```\n2. Then run it.',
      );
      // One list, and the code box lives inside the first item.
      expect((html.match(/<ol/g) || []).length).toBe(1);
      expect(html).toContain('<li>Install it:<div class="code-lang">bash</div>');
      expect(html).toContain('</pre></li><li>Then run it.</li>');
      // The indent that merely positioned it under the bullet is not shown.
      expect(html).toContain('<code>npm install</code>');
    });
    test('a longer fence can contain a shorter one', () => {
      const html = renderRichText('````\n```js\nconst x = 1;\n```\n````');
      // One box, with the inner fence kept as content rather than closing it.
      // Compared on text, since the highlighter wraps tokens in spans.
      expect((html.match(/<pre class="codeblock">/g) || []).length).toBe(1);
      const text = html.replace(/<[^>]+>/g, '');
      expect(text).toContain('```js');
      expect(text).toContain('const x = 1;');
    });
    test('an unclosed fence still renders as code rather than vanishing', () => {
      const html = renderRichText('Here:\n```py\nprint(1)');
      expect(html).toContain('<pre class="codeblock">');
      expect(html.replace(/<[^>]+>/g, '')).toContain('print(1)');
    });
    test('renders a table as a real table, not raw pipes', () => {
      const html = renderRichText(
        '| View | Shown |\n|---|---|\n| Time ascending | 6 / 183 |\n| Session | 42 / 183 |',
      );
      expect(html).toContain('<div class="md-table-wrap"><table class="md-table">');
      expect(html).toContain('<th>View</th>');
      expect(html).toContain('<th>Shown</th>');
      expect(html).toContain('<td>Time ascending</td>');
      expect(html).toContain('<td>42 / 183</td>');
      expect((html.match(/<tr>/g) || []).length).toBe(3); // header + 2 body rows
      // None of the source markup survives as text.
      expect(html).not.toContain('|---');
      expect(html).not.toContain('| View');
    });
    test('honours column alignment from the separator row', () => {
      const html = renderRichText('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |');
      expect(html).toContain('<th style="text-align:left">L</th>');
      expect(html).toContain('<th style="text-align:center">C</th>');
      expect(html).toContain('<th style="text-align:right">R</th>');
      expect(html).toContain('<td style="text-align:right">c</td>');
    });
    test('formats inline markup inside cells and escapes their content', () => {
      const html = renderRichText('| What | Note |\n|---|---|\n| **bold** | `code` |');
      expect(html).toContain('<td><strong>bold</strong></td>');
      expect(html).toContain('<td><code>code</code></td>');
      // A cell is escaped like everything else — no raw HTML gets through.
      const evil = renderRichText('| x |\n|---|\n| <b>hi</b> |');
      expect(evil).toContain('&lt;b&gt;hi&lt;/b&gt;');
      expect(evil).not.toContain('<b>hi</b>');
    });
    test('pads a ragged row instead of emitting broken markup', () => {
      const html = renderRichText('| a | b | c |\n|---|---|---|\n| only one |');
      // Three columns in every row, so the table stays well-formed.
      expect((html.match(/<td/g) || []).length).toBe(3);
      expect(html).toContain('<td>only one</td>');
    });
    test('leaves pipes alone when there is no separator row', () => {
      // The regression guard: a shell pipeline must never become a table.
      const html = renderRichText('Run `grep foo | wc -l` to count.\na | b | c');
      expect(html).not.toContain('<table');
      expect(html).toContain('a | b | c');
    });
    test('keeps a table inside a fenced code block literal', () => {
      const html = renderRichText('```\n| a | b |\n|---|---|\n```');
      expect(html).not.toContain('<table');
      expect(html).toContain('<pre class="codeblock">');
      expect(html).toContain('| a | b |');
    });
    test('renders a table inside a blockquote', () => {
      const html = renderRichText('> | a | b |\n> |---|---|\n> | 1 | 2 |');
      expect(html).toContain('<blockquote>');
      expect(html).toContain('<table class="md-table">');
      expect(html).toContain('<td>1</td>');
    });
    test('treats an escaped pipe as cell content, not a column break', () => {
      const html = renderRichText('| cmd |\n|---|\n| a \\| b |');
      expect((html.match(/<td/g) || []).length).toBe(1);
      expect(html).toContain('<td>a | b</td>');
    });
    test('shows a non-http link as its label, dropping the dead target', () => {
      const html = renderRichText(
        '[game.py](file:///C:/Users/me/.gemini/scratch/game.py)',
      );
      expect(html).toContain('game.py');
      expect(html).not.toContain('file://');
      expect(html).not.toContain('](');
    });
    test('preserves ordered-list numbering via start when it begins past 1', () => {
      const html = renderRichText('2. second\n3. third');
      expect(html).toContain('<ol start="2">');
      // A normal list from 1 stays clean (no start attribute).
      expect(renderRichText('1. a\n2. b')).toContain('<ol>');
    });
    test('still renders fenced code as a code block', () => {
      const html = renderRichText('Run:\n```bash\npython game.py\n```');
      expect(html).toContain('class="codeblock"');
      expect(html).toContain('python game.py');
    });
  });
  // Reports are never pruned, so a second run leaves the first on disk. Two
  // guards keep a test from silently asserting against a stale artifact — the
  // failure mode that made catchUp.test.ts intermittently fail.
  describe('report files', () => {});
});
