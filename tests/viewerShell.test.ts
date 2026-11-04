import { expect, test } from 'bun:test';
import { renderHtml } from '../src/core/report/html.ts';
import { HistoryStore } from '../src/core/history.ts';
import { buildHistoryReport } from '../src/core/historyReport.ts';
import { fixture } from './centralHelpers.ts';
import { readViewer } from './viewerHelpers.ts';

test('portable shell preserves replacement tokens and marker-shaped captured text in every section', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'codex', cwd: project });
    const literal =
      "$& $$ $' $` SHOWTAIL_TURNS_PLACEHOLDER SHOWTAIL_UNATTRIBUTED_WORK SHOWTAIL_FILE_OBSERVATIONS </script><script>window.injected=true</script>";
    store.append(session.id, { kind: 'prompt', text: literal });
    store.append(session.id, { kind: 'ai_output', text: literal });
    store.append(session.id, { kind: 'tool_call', text: literal, toolName: 'Tool' });
    store.append(session.id, { kind: 'plan', text: literal });
    store.append(session.id, {
      kind: 'edit',
      file: project + '/literal.ts',
      diff: '+' + literal,
    });
    const data = buildHistoryReport(store, { kind: 'all' });
    const original = JSON.stringify(data);
    const html = renderHtml(data);
    const decoded = readViewer(html);
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/id="st-report-app"/g)).toHaveLength(1);
    expect(html.match(/id="st-report-manifest"/g)).toHaveLength(1);
    expect(html).not.toContain('<script>window.injected=true</script>');
    expect(decoded.texts.get(decoded.index.turns[0]!.promptRef!)).toBe(literal);
    for (const kind of ['ai', 'tool', 'plan', 'revision']) {
      const item = Object.values(decoded.index.items).find((item) => item.kind === kind)!;
      expect(decoded.texts.get(item.textRef!)).toContain(literal);
    }
    expect(JSON.stringify(data)).toBe(original);
  }));

test('initial HTML contains only one preview page while every prompt stays in its offline payload', () =>
  fixture(({ project }) => {
    using store = new HistoryStore();
    const session = store.ensureSession({ tool: 'codex', cwd: project });
    for (let n = 0; n < 201; n++)
      store.append(session.id, { kind: 'prompt', text: `Unique prompt ${n}` });
    const html = renderHtml(buildHistoryReport(store, { kind: 'all' }));
    const decoded = readViewer(html);
    expect(html.match(/<li>/g)).toHaveLength(25);
    expect(decoded.index.turns).toHaveLength(201);
    expect(decoded.texts.get(decoded.index.turns[200]!.promptRef!)).toBe(
      'Unique prompt 200',
    );
    expect(html).toContain('<noscript>');
    expect(html).toContain('connect-src &#39;none&#39;');
  }));
