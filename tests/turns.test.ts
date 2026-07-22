import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact, importEditArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import { buildReportData, renderHtml, renderMarkdown } from '../src/core/report.ts';
import { startSession } from '../src/core/sessions.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

describe('turns', () => {
  test('groups a prompt with its AI output and code change by turnId', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);

      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Here is a hello function.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      writeFileSync(join(dir, 'hello.ts'), 'export const hello = () => "hi";');
      await addArtifact(author, {
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

  test('a code change with no captured diff renders a plain file row, not an empty expander', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);

      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'rename a constant',
        tool: 'claude-code',
      });
      writeFileSync(join(dir, 'util.ts'), 'export const x = 1;');
      // No `diff` — e.g. a Codex shell edit, or capture without suggested code.
      await addArtifact(author, {
        filePath: 'util.ts',
        tool: 'claude-code',
        turnId: prompt.id,
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('util.ts');
      // Rendered as a plain row, not an expander that opens to nothing.
      expect(html).toContain('class="code code-file"');
      expect(html).not.toContain('<details class="code">');
    } finally {
      cleanup(dir);
    }
  });

  test('falls back to timestamp adjacency when turnId is absent', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);

      await logEvent(author, { type: 'prompt', text: 'first prompt', tool: 'chatgpt' });
      await logEvent(author, {
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
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'hello world in python',
        tool: 'chatgpt',
      });
      await logEvent(author, {
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
      // The only script in the document is the trusted inline timezone helper;
      // rendering user content must never introduce another.
      expect(html.match(/<script\b/g)?.length ?? 0).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('renders Markdown in an AI response (bold/heading/list/link), no raw marks', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'explain',
        tool: 'chatgpt',
      });
      await logEvent(author, {
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
      // The only script in the document is the trusted inline timezone helper;
      // rendering user content must never introduce another.
      expect(html.match(/<script\b/g)?.length ?? 0).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('renders collapsible <details> cards with diff coloring and no <script>', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'write a test',
        tool: 'claude-code',
      });
      writeFileSync(join(dir, 'a.ts'), 'const a = 2;');
      await addArtifact(author, {
        filePath: 'a.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        diff: '- const a = 1;\n+ const a = 2;',
      });

      const html = renderHtml(buildReportData(paths));
      expect(html).toContain('<details class="turn"');
      expect(html).toContain('class="badge badge--claude-code"');
      // Each changed line is a single .dline block with a +/- gutter (.dmark).
      expect(html).toContain('class="dline del"');
      expect(html).toContain('class="dline add"');
      expect(html).toContain('class="dmark"');
      // Code inside the diff is syntax-highlighted with the shared tok-* theme.
      expect(html).toContain('class="tok-kw"');
      // Rows are adjacent — no empty (gray-gap) line is emitted between them.
      expect(html).toContain('</span><span class="dline');
      // A Close button collapses the card via an inline handler (no card script).
      expect(html).toContain('class="turn-close"');
      expect(html).toContain('open=false');
      // The only script in the document is the trusted inline timezone helper;
      // rendering user content must never introduce another.
      expect(html.match(/<script\b/g)?.length ?? 0).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test('collapses every AI message into one per-prompt group; only the work is inline', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      // Two AI replies — a long one and a short one. Uniformly, both collapse; the
      // classifier makes no content judgement, so the rule is predictable.
      await logEvent(author, {
        type: 'ai_output',
        text: 'First, let me explain the approach in some detail so the reasoning is clear.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Done, all set.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      await logEvent(author, {
        type: 'decision',
        text: 'Use an arrow function',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      writeFileSync(join(dir, 'hello.ts'), 'export const hello = () => "hi";');
      await addArtifact(author, {
        filePath: 'hello.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        sessionId: session.id,
        diff: '+ export const hello = () => "hi";',
      });

      const html = renderHtml(buildReportData(paths));
      const pill = html.indexOf('class="ai-process"');
      expect(pill).toBeGreaterThan(-1);
      // Both AI messages — long and short alike — fold into the one counted group…
      expect(html).toContain('2 AI messages'); // the pill's count
      expect(html).not.toContain('<details class="ai-process" open>'); // collapsed by default
      // …the student's work reads inline, before the pill…
      expect(html.indexOf('hello.ts')).toBeLessThan(pill);
      expect(html.indexOf('Use an arrow function')).toBeLessThan(pill);
      // …and no AI prose is inline — it appears only inside the collapsed group.
      expect(html.indexOf('First, let me explain')).toBeGreaterThan(pill);
      expect(html.indexOf('Done, all set.')).toBeGreaterThan(pill);
    } finally {
      cleanup(dir);
    }
  });

  test('a <task-notification> prompt opens no turn; the AI after it attaches to the prior prompt', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: real } = await logEvent(author, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      // A background-subagent result, injected as a user turn — older trails captured
      // these as prompts. It must not become its own (giant) turn.
      const { event: synthetic } = await logEvent(author, {
        type: 'prompt',
        text: '<task-notification>\n<task-id>x</task-id>\nAgent finished with a long report.',
        tool: 'claude-code',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Continuing after the background task.',
        tool: 'claude-code',
        turnId: synthetic.id,
      });

      const data = buildReportData(paths);
      // Only the real prompt opens a turn.
      expect(data.turns).toHaveLength(1);
      expect(data.turns[0]!.prompt.id).toBe(real.id);
      // The reply that followed the notification attaches to the real prompt's turn.
      expect(data.turns[0]!.aiOutputs.map((e) => e.text)).toContain(
        'Continuing after the background task.',
      );
      // The notification never renders as a prompt.
      expect(renderMarkdown(data)).not.toContain('<task-id>');
    } finally {
      cleanup(dir);
    }
  });

  test('renders the exchanges toolbar and wrapper with the three controls', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Sure.',
        tool: 'claude-code',
        turnId: prompt.id,
      });

      const html = renderHtml(buildReportData(paths));
      // Wrapper + sticky bar, rendered hidden until JS enables it (progressive enhancement).
      expect(html).toContain('id="st-exchanges"');
      expect(html).toContain('<div class="st-exbar" hidden>');
      // The three controls: expand/collapse-all, the AI switch, and Time|Session sort.
      expect(html).toContain('id="st-expand"');
      expect(html).toContain('id="st-ai"');
      expect(html).toContain('id="st-sort"');
      expect(html).toContain('data-mode="time"');
      expect(html).toContain('data-mode="session"');
      // Turns carry the data the sort/group reads.
      expect(html).toMatch(/<details class="turn" data-ts="/);
      expect(html).toContain('data-session="');
    } finally {
      cleanup(dir);
    }
  });

  test('--ai off omits AI text but keeps the prompt, decisions, and changes', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const session = startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a hello function',
        tool: 'claude-code',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: 'Here is the hello function you asked for.',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      await logEvent(author, {
        type: 'decision',
        text: 'Use an arrow function',
        tool: 'claude-code',
        turnId: prompt.id,
      });
      writeFileSync(join(dir, 'hello.ts'), 'export const hello = () => "hi";');
      await addArtifact(author, {
        filePath: 'hello.ts',
        tool: 'claude-code',
        turnId: prompt.id,
        sessionId: session.id,
        diff: '+ export const hello = () => "hi";',
      });

      const data = buildReportData(paths);
      const html = renderHtml(data, { ai: 'off' });
      // AI narration is gone entirely — no reply text, no process disclosure
      // element (the class still appears once in the inlined stylesheet).
      expect(html).not.toContain('Here is the hello function');
      expect(html).not.toContain('class="ai-process"');
      expect(html).not.toContain('id="st-ai"'); // no toggle when there's no AI layer
      // The student's own work survives untouched.
      expect(html).toContain('add a hello function'); // prompt
      expect(html).toContain('Use an arrow function'); // decision
      expect(html).toContain('hello.ts'); // change

      // Same contract for the Markdown export.
      const md = renderMarkdown(data, { ai: 'off' });
      expect(md).not.toContain('_AI response:_');
      expect(md).not.toContain('Here is the hello function');
      expect(md).toContain('Use an arrow function');
      expect(md).toContain('hello.ts');
    } finally {
      cleanup(dir);
    }
  });

  test('--ai full expands the process disclosure and pre-checks the toggle', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'add a parser',
        tool: 'claude-code',
      });
      // One collapsible status line + one rationale that made an edit, so there's a
      // process group to expand.
      const editTs = '2026-07-01T10:00:02.000Z';
      await logEvent(author, {
        type: 'ai_output',
        text: 'Let me check the layout.',
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: '2026-07-01T10:00:01.000Z',
      });
      await logEvent(author, {
        type: 'ai_output',
        text: "I'll add the parser.",
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: editTs,
      });
      importEditArtifact(author, {
        path: 'parser.ts',
        diff: '+ export const parse = () => {}',
        tool: 'claude-code',
        turnId: prompt.id,
        timestamp: editTs,
      });

      const html = renderHtml(buildReportData(paths), { ai: 'full' });
      expect(html).toContain('<details class="ai-process" open>');
      expect(html).toContain('id="st-ai" checked');
    } finally {
      cleanup(dir);
    }
  });

  test('captured text containing the timestamp sentinel does not corrupt the report', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      startSession(author);
      const { event: prompt } = await logEvent(author, {
        type: 'prompt',
        text: 'why does SHOWTAILTIME@2026-01-01T00:00:00.000Z@ appear?',
        tool: 'claude-code',
      });
      // Showtail captures its own sessions, so an AI message can literally contain
      // the timestamp sentinel. Here it spans some `inline code` — the global token
      // regex used to match across it and swallow the </code>, orphaning the tag
      // (monospace tail) and producing a <time> with markup in its datetime.
      await logEvent(author, {
        type: 'ai_output',
        text: 'Token talk: SHOWTAILTIME@ then `inline code` then SHOWTAILTIME@2026-01-01T00:00:00.000Z@ done.',
        tool: 'claude-code',
        turnId: prompt.id,
      });

      const html = renderHtml(buildReportData(paths));
      // The sentinel inside captured content is left as literal escaped text, not
      // swapped — proof the global regex never scanned the turn card.
      expect(html).toContain('SHOWTAILTIME@2026-01-01T00:00:00.000Z@');
      // The inline code in the AI text survives intact (its </code> was not eaten).
      expect(html).toContain('<code>inline code</code>');
      // No <time> element swallowed markup into its datetime attribute.
      expect(html).not.toMatch(/datetime="[^"]*&lt;/);
      // Document structure stays balanced (the corruption's signature was an
      // unclosed <code> / unbalanced <div>).
      expect((html.match(/<code>/g) ?? []).length).toBe(
        (html.match(/<\/code>/g) ?? []).length,
      );
      expect((html.match(/<div\b/g) ?? []).length).toBe(
        (html.match(/<\/div>/g) ?? []).length,
      );
      // Real event timestamps still render as live <time> elements.
      expect(html).toContain('<time class="st-time"');
    } finally {
      cleanup(dir);
    }
  });
});
