import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { runReport } from '../src/commands/report.ts';
import { addArtifact, importEditArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import {
  buildReportData,
  markdownToHtml,
  renderHtml,
  renderMarkdown,
  renderRichText,
} from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot, readConfig } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir, readJsonReport } from './helpers.ts';

describe('report', () => {
  test('aggregates events and artifacts into structured data and markdown', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);

      await logEvent(author, { type: 'prompt', text: 'How do I structure this parser?' });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Split the input on newlines, then parse each row into fields.',
      });

      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      await addArtifact(author, { filePath: 'parser.ts' });

      const data = buildReportData(paths);
      expect(data.project).toBe('Parser Project');
      expect(data.turns).toHaveLength(1);
      expect(data.summary.artifacts).toBe(1);
      // Team report with a single contributor attests the work is their own.
      expect(data.authorship).toContain('their own');

      const md = renderMarkdown(data);
      expect(md).toContain('# Showtail Report — Parser Project');
      expect(md).toContain('How do I structure this parser?');
      expect(md).toContain('## Prompts & AI exchanges');
      expect(md).toContain('## Authorship statement');
      // The removed sections are gone.
      expect(md).not.toContain('## Project timeline');
      expect(md).not.toContain('## Major decisions');
      expect(md).not.toContain('## Artifacts created');
      expect(md).not.toContain('## Student reflections');
    } finally {
      cleanup(dir);
    }
  });

  test('Markdown leads with a reader-friendly summary and folds AI into in-place details', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);

      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a CSV parser',
        tool: 'claude-code',
        timestamp: '2026-07-01T10:00:00.000Z',
      });
      // AI before the edit and after it → two in-place <details>, the edit between.
      await logEvent(author, {
        type: 'ai_output',
        text: 'Reading the files first.',
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: '2026-07-01T10:00:01.000Z',
      });
      importEditArtifact(author, {
        path: 'parser.ts',
        diff: '+ export const parse = () => {}',
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: '2026-07-01T10:00:02.000Z',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Done, tests pass.',
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: '2026-07-01T10:00:03.000Z',
      });

      const md = renderMarkdown(buildReportData(paths));
      // The summary leads with what a reviewer scans for: tasks (prompts).
      expect(md).toMatch(/\*\*Summary:\*\* 1 task\b/);
      // The AI runs read as plain prose — no wrapper, no header, no label.
      expect(md).not.toContain('AI message');
      expect(md).not.toContain('_AI response:_');
      // The edit reads inline, chronologically between the two AI runs.
      const iFirst = md.indexOf('Reading the files first');
      const iEdit = md.indexOf('parser.ts');
      const iSecond = md.indexOf('Done, tests pass');
      expect(iFirst).toBeLessThan(iEdit);
      expect(iEdit).toBeLessThan(iSecond);
    } finally {
      cleanup(dir);
    }
  });

  test('empty project still renders a valid report', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const md = renderMarkdown(buildReportData(paths));
      expect(md).toContain('# Showtail Report');
      expect(md).toContain('No prompts recorded.');
    } finally {
      cleanup(dir);
    }
  });

  test('renders a standalone HTML document from the same data', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, { type: 'prompt', text: 'How do I structure this parser?' });

      const html = renderHtml(buildReportData(paths));
      expect(html.toLowerCase().startsWith('<!doctype html')).toBe(true);
      expect(html).toContain('<html');
      expect(html).toContain('Showtail Report — Parser Project');
      expect(html).toContain('How do I structure this parser?');
      expect(html).toContain('<h2>');
      // Authorship statement renders as a blockquote.
      expect(html).toContain('<blockquote>');
    } finally {
      cleanup(dir);
    }
  });

  test('HTML carries timestamps as interactive <time> elements with a timezone selector', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, { type: 'prompt', text: 'How do I structure this parser?' });

      const data = buildReportData(paths);
      const html = renderHtml(data);

      // Every timestamp is a <time> element holding the raw UTC instant plus a
      // readable UTC fallback (so it still reads correctly with JS disabled).
      expect(html).toMatch(/<time class="st-time" datetime="[^"]+Z">/);
      expect(html).toContain(' UTC</time>');
      // The token placeholder must have been fully swapped out.
      expect(html).not.toContain('SHOWTAILTIME@');

      // The selector + inline script default to the viewer's machine timezone.
      expect(html).toContain('<select id="st-tz"');
      expect(html).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
      expect(html).toContain('timeZoneName: ');
      expect(html).toContain("querySelectorAll('time.st-time')");
      // Picker option labels carry the short code and numeric GMT offset.
      expect(html).toContain('formatToParts');
      expect(html).toContain("'shortOffset'");
    } finally {
      cleanup(dir);
    }
  });

  test('Markdown export keeps static, readable UTC timestamps (no scripts)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, { type: 'prompt', text: 'How do I structure this parser?' });

      const md = renderMarkdown(buildReportData(paths));
      // Readable UTC like "20 Jun 2026, 21:30 UTC", and no <time> tags or tokens.
      expect(md).toMatch(/Generated \d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
      expect(md).not.toContain('<time');
      expect(md).not.toContain('SHOWTAILTIME@');
    } finally {
      cleanup(dir);
    }
  });

  test('HTML escapes user-supplied text', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'XSS Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      await logEvent(author, {
        type: 'prompt',
        text: '<script>alert(1)</script> tom & jerry',
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('tom &amp; jerry');
    } finally {
      cleanup(dir);
    }
  });

  test('empty project still renders a valid HTML document', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const html = renderHtml(buildReportData(paths));
      expect(html.toLowerCase().startsWith('<!doctype html')).toBe(true);
      // With no project name, the title falls back to the folder name.
      expect(html).toContain('<h1>Showtail Report —');
      expect(html).toContain('No prompts recorded.');
    } finally {
      cleanup(dir);
    }
  });

  test('links code-change file paths relative to the report (HTML + Markdown)', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = startSession(author);
      await logEvent(author, { type: 'prompt', text: 'Help me structure a CSV parser.' });

      // A normal path and one with a space, both edited in this turn. Passing the
      // session id is what links the artifact to the prompt's turn (as the hooks do).
      writeFileSync(join(dir, 'src-parser.ts'), 'export const parse = () => {};');
      await addArtifact(author, { filePath: 'src-parser.ts', sessionId: session.id });
      writeFileSync(join(dir, 'my file.ts'), 'export const x = 1;');
      await addArtifact(author, { filePath: 'my file.ts', sessionId: session.id });

      const data = buildReportData(paths);
      const html = renderHtml(data);
      const md = renderMarkdown(data);

      // Reports live in .showtail/reports/, so ../../ steps back to the repo root.
      expect(html).toContain('href="../../src-parser.ts"');
      expect(html).toContain('class="file-link"');
      expect(html).toContain('event.stopPropagation()');
      expect(md).toContain('](../../src-parser.ts)');

      // Spaces (and other unsafe chars) are URL-encoded per segment.
      expect(html).toContain('href="../../my%20file.ts"');
      expect(md).toContain('](../../my%20file.ts)');
    } finally {
      cleanup(dir);
    }
  });

  test('title falls back to the folder name when no project is set', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const data = buildReportData(pathsForRoot(dir));
      expect(data.project).toBeNull(); // nothing configured
      expect(data.displayName).toBe(basename(dir)); // resolved fallback
      expect(renderMarkdown(data)).toContain(`# Showtail Report — ${basename(dir)}`);
    } finally {
      cleanup(dir);
    }
  });

  test('--title overrides the configured project name for one report', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Configured Name' });
      const data = buildReportData(pathsForRoot(dir), { title: 'One-off Title' });
      expect(data.project).toBe('Configured Name'); // configured value preserved
      expect(data.displayName).toBe('One-off Title'); // override wins
      expect(renderMarkdown(data)).toContain('# Showtail Report — One-off Title');
    } finally {
      cleanup(dir);
    }
  });

  test('init --project sets/updates the name on an already-initialized project', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir }); // no project name
      const paths = pathsForRoot(dir);
      expect(readConfig(paths).project).toBeUndefined();

      await runInit({ cwd: dir, project: 'Week 5 Parser' }); // re-run sets it
      expect(readConfig(paths).project).toBe('Week 5 Parser');
      expect(buildReportData(paths).displayName).toBe('Week 5 Parser');

      await runInit({ cwd: dir, project: 'Week 6 Parser' }); // re-run updates it
      expect(readConfig(paths).project).toBe('Week 6 Parser');
    } finally {
      cleanup(dir);
    }
  });

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
  describe('report files', () => {
    test('keeps two reports generated in the same second as distinct files', async () => {
      const dir = makeTempDir();
      try {
        await runInit({ cwd: dir, project: 'Stamp' });
        const author = authorFor(pathsForRoot(dir));
        startSession(author);
        await logEvent(author, { type: 'prompt', text: 'first' });

        await runReport({ cwd: dir, format: 'json', sync: false });
        await logEvent(author, { type: 'prompt', text: 'second' });
        await runReport({ cwd: dir, format: 'json', sync: false });

        // Back-to-back in-process runs land in the same wall-clock second, so a
        // second-precision stamp would collide and the second would overwrite
        // the first.
        const reports = readdirSync(join(dir, '.showtail', 'reports')).filter((f) =>
          f.endsWith('.json'),
        );
        expect(reports).toHaveLength(2);
        // ...and the helper must hand back the newer of the two.
        expect(readJsonReport(dir).summary.events).toBe(2);
      } finally {
        cleanup(dir);
      }
    });

    test('readJsonReport returns the newest report, not the first on disk', () => {
      const dir = makeTempDir();
      try {
        // Hand-built so the assertion does not depend on readdir order, which is
        // hash order on APFS: whichever file the filesystem lists first, the
        // later ISO stamp must win.
        const reportsDir = join(dir, '.showtail', 'reports');
        mkdirSync(reportsDir, { recursive: true });
        const write = (stamp: string, marker: string) =>
          writeFileSync(
            join(reportsDir, `report-tester-${stamp}.json`),
            JSON.stringify({ marker }),
          );
        write('2026-01-02T000000000', 'newer');
        write('2026-01-01T000000000', 'older');

        expect(readJsonReport(dir).marker).toBe('newer');
      } finally {
        cleanup(dir);
      }
    });
  });
});
