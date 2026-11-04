import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the DOM-only contract without providing an HTML parser or network API.
class Node {
  childNodes: Node[] = [];
  attributes: Record<string, string> = {};
  className = '';
  href?: string;
  rel?: string;
  target?: string;
  constructor(
    public tagName: string,
    public value = '',
  ) {}
  appendChild(child: Node) {
    if (child.tagName === '#fragment')
      this.childNodes.push(...child.childNodes.splice(0));
    else this.childNodes.push(child);
    return child;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  get textContent(): string {
    return this.value + this.childNodes.map((n) => n.textContent).join('');
  }
  set innerHTML(_: string) {
    throw new Error('HTML parsing is not part of the rich-text contract');
  }
}
const document = {
  createElement: (tag: string) => new Node(tag),
  createTextNode: (text: string) => new Node('#text', text),
  createDocumentFragment: () => new Node('#fragment'),
};
const sandbox: any = { URL, TextEncoder };
runInNewContext(readFileSync('assets/report/viewer-richtext.js', 'utf8'), sandbox);
const render = (text: string, options = {}): Node =>
  sandbox.ShowtailRichText.render(text, { document, ...options });
const codeText = (text: string, options = {}): Node & { nodeCount: number } =>
  sandbox.ShowtailRichText.code(text, { document, ...options });
const nodes = (node: Node): Node[] => [node, ...node.childNodes.flatMap(nodes)];
const elements = (node: Node, tag: string) =>
  nodes(node).filter((n) => n.tagName === tag);

test('mounted prose supports headings, emphasis, code, nested lists, tables, quotes and fences', () => {
  const result = render(
    '# Heading\n\n**bold** _quiet_ `inline`\n\n- outer\n  - inner\n\n2. second\n3. third\n\n| A | B |\n|:---|---:|\n| one | two |\n\n> [!NOTE]\n> quoted\n\n```js\nconst value = 1;\n```',
  );
  expect(elements(result, 'h2')[0]!.textContent).toBe('Heading');
  expect(elements(result, 'strong').some((n) => n.textContent === 'bold')).toBe(true);
  expect(elements(result, 'em')[0]!.textContent).toBe('quiet');
  expect(elements(result, 'ul')).toHaveLength(2);
  expect(elements(result, 'ol')[0]!.attributes.start).toBe('2');
  expect(elements(result, 'table')).toHaveLength(1);
  expect(elements(result, 'td').map((n) => n.textContent)).toEqual(['one', 'two']);
  expect(elements(result, 'blockquote')[0]!.textContent).toContain('quoted');
  expect(elements(result, 'pre')[0]!.textContent).toBe('const value = 1;');
});

test('captured HTML, hostile links and images cannot create executable or network-loading elements', () => {
  const result = render(
    '<script>globalThis.compromised = true</script>\n<img src="https://remote.test/pixel" onerror="alert(1)">\n\n[safe](https://example.test/path) [bad](javascript:alert(1)) [data](data:text/html,test) [file](file:///private) ![image](https://remote.test/image)\n\n```html\n</code><script>evil()</script>\n```',
  );
  for (const forbidden of ['script', 'img', 'iframe', 'style', 'object'])
    expect(elements(result, forbidden)).toHaveLength(0);
  expect(elements(result, 'a').map((n) => n.href)).toEqual(['https://example.test/path']);
  expect(elements(result, 'a')[0]!.rel).toContain('noreferrer');
  expect(result.textContent).toContain('<script>globalThis.compromised = true</script>');
  expect(elements(result, 'pre')[0]!.textContent).toBe('</code><script>evil()</script>');
  expect(sandbox.compromised).toBeUndefined();
});

test('fenced-code continuation closes correctly before subsequent prose', () => {
  const result = render('const secondPage = true;\n```\n## Following heading', {
    context: { fence: { marker: '```', language: 'js' } },
  });
  expect(elements(result, 'pre')[0]!.textContent).toBe('const secondPage = true;');
  expect(elements(result, 'h3')[0]!.textContent).toBe('Following heading');
  const raw = render('> kept code operator\n```', {
    context: { fence: { marker: '```', language: 'text', quoteDepth: 0 } },
  });
  expect(elements(raw, 'pre')[0]!.textContent).toBe('> kept code operator');
  const quoted = render('> > kept inside quoted code\n> ```', {
    context: { fence: { marker: '```', language: 'text', quoteDepth: 1 } },
  });
  expect(elements(quoted, 'pre')[0]!.textContent).toBe('> kept inside quoted code');
});

test('table and ordered-list continuation reuse semantic structure across raw pages', () => {
  const table = render('| next | value |\n| last | row |', {
    context: { table: { header: '| A | B |', separator: '|---|---|' } },
  });
  expect(elements(table, 'th').map((n) => n.textContent)).toEqual(['A', 'B']);
  expect(elements(table, 'td').map((n) => n.textContent)).toEqual([
    'next',
    'value',
    'last',
    'row',
  ]);
  const list = render('  continued paragraph\n3. next item', {
    context: { list: { ordered: true, start: 2, indent: 0 } },
  });
  expect(elements(list, 'ol').map((n) => n.attributes.start)).toEqual(['2', '3']);
  expect(list.textContent).toContain('continued paragraph');
});

test('complex or oversized blocks fall back to exact plain text with a bounded DOM', () => {
  for (const text of [
    Array.from({ length: 1000 }, (_, n) => `**word${n}**`).join(' '),
    'x'.repeat(1024 * 1024),
  ]) {
    const result = render(text);
    expect(elements(result, 'pre')[0]!.attributes['data-rich-fallback']).toBeDefined();
    expect(result.textContent).toBe(text);
    expect(nodes(result).length).toBeLessThan(5);
  }
  const partial = 'code continuation that looks like **markup**';
  expect(render(partial, { context: { partialLine: true } }).textContent).toBe(partial);
  const wide = '| full | original row |';
  const wideResult = render(wide, { context: { table: { oversized: true } } });
  expect(wideResult.textContent).toBe(wide);
  expect(elements(wideResult, 'pre')[0]!.attributes['data-rich-fallback']).toBe(
    'oversized-continuation',
  );
});

test('long hostile delimiter runs finish without unbounded regex backtracking', () => {
  const started = performance.now();
  const result = render('prefix ' + '['.repeat(32000) + '`'.repeat(32000));
  expect(result.textContent.length).toBe(64007);
  expect(performance.now() - started).toBeLessThan(1000);
});

test('mounted code colors keywords, strings, comments, numbers and calls while preserving exact source', () => {
  const source =
    'export const value = build("<script>inert</script>", 42); // comment\r\n# shell comment\n/* block comment */';
  const result = codeText(source);
  expect(result.textContent).toBe(source);
  const spans = elements(result, 'span');
  for (const cls of ['tok-kw', 'tok-str', 'tok-com', 'tok-num', 'tok-fn'])
    expect(spans.some((n) => n.className === cls)).toBe(true);
  expect(spans.some((n) => n.textContent === 'value')).toBe(false);
  expect(spans.find((n) => n.className === 'tok-str')!.textContent).toBe(
    '"<script>inert</script>"',
  );
  expect(elements(result, 'script')).toHaveLength(0);
  expect(elements(result, 'a')).toHaveLength(0);
  expect(result.nodeCount).toBe(nodes(result).length - 1);
});

test('code coloring respects UTF8 line and DOM budgets without withholding or changing text', () => {
  for (const line of ['const ' + 'long_name'.repeat(600), 'const ' + '界'.repeat(1400)]) {
    const result = codeText(line);
    expect(elements(result, 'span')).toHaveLength(0);
    expect(result.textContent).toBe(line);
    expect(result.nodeCount).toBe(1);
  }
  const source = Array.from(
    { length: 115 },
    (_, n) => `const value_${n} = build("line", ${n}); // preserved`,
  ).join('\n');
  const limited = codeText(source, { maxNodes: 7 });
  expect(limited.nodeCount).toBeLessThanOrEqual(7);
  expect(limited.textContent).toBe(source);
  const fenced = render('```js\n' + source + '\n```', { maxNodes: 1500 });
  expect(elements(fenced, 'pre')[0]!.textContent).toBe(source);
  expect(elements(fenced, 'span').length).toBeGreaterThan(0);
  expect(nodes(fenced).length).toBeLessThanOrEqual(1501);
});
