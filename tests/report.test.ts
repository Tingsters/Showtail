import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import {
  buildReportData,
  markdownToHtml,
  renderHtml,
  renderMarkdown,
} from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('report', () => {
  test('aggregates events and artifacts into structured data and markdown', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'Parser Project' });
      const paths = pathsForRoot(dir);
      startSession(paths);

      await logEvent(paths, { type: 'prompt', text: 'How do I structure this parser?' });
      await logEvent(paths, {
        type: 'decision',
        text: 'I chose the simpler regex approach.',
      });
      await logEvent(paths, {
        type: 'reflection',
        text: 'I understand the tokenizer now.',
      });
      await logEvent(paths, { type: 'source', text: 'Used class notes from week 3.' });
      await logEvent(paths, {
        type: 'test',
        text: 'Ran the edge-case suite, all green.',
      });

      writeFileSync(join(dir, 'parser.ts'), 'export const parse = () => {};');
      await addArtifact(paths, { filePath: 'parser.ts' });

      const data = buildReportData(paths);
      expect(data.project).toBe('Parser Project');
      expect(data.turns).toHaveLength(1);
      expect(data.summary.artifacts).toBe(1);
      expect(data.authorship).toContain('my own');

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
      startSession(paths);
      await logEvent(paths, { type: 'prompt', text: 'How do I structure this parser?' });

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

  test('HTML escapes user-supplied text', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir, project: 'XSS Project' });
      const paths = pathsForRoot(dir);
      startSession(paths);
      await logEvent(paths, {
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
      expect(html).toContain('<h1>Showtail Report</h1>');
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
      const session = startSession(paths);
      await logEvent(paths, { type: 'prompt', text: 'Help me structure a CSV parser.' });

      // A normal path and one with a space, both edited in this turn. Passing the
      // session id is what links the artifact to the prompt's turn (as the hooks do).
      writeFileSync(join(dir, 'src-parser.ts'), 'export const parse = () => {};');
      await addArtifact(paths, { filePath: 'src-parser.ts', sessionId: session.id });
      writeFileSync(join(dir, 'my file.ts'), 'export const x = 1;');
      await addArtifact(paths, { filePath: 'my file.ts', sessionId: session.id });

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
});
