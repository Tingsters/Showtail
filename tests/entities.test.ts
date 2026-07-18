import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { addArtifact } from '../src/core/artifacts.ts';
import { logEvent } from '../src/core/events.ts';
import {
  diffEntitiesDetailed,
  entityLabel,
  extractEntities,
  hasEntityChanges,
  supportsEntities,
} from '../src/core/entities.ts';
import { LANGUAGES } from '../src/core/grammars.ts';
import { buildReportData } from '../src/core/report/data.ts';
import { renderHtml } from '../src/core/report/html.ts';
import { renderMarkdown } from '../src/core/report/markdown.ts';
import { pathsForRoot } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir } from './helpers.ts';

describe('extractEntities', () => {
  test('extracts functions, classes, methods, and arrow consts (qualified)', async () => {
    const src = `export function parseConfig(x: number) { return x + 1 }
class Widget {
  render() { return 1 }
  static make() {}
}
const arrow = () => 3;`;
    const ents = await extractEntities(src, 'a.ts');
    expect(ents).toBeDefined();
    const byName = new Map(ents!.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(
      ['Widget', 'Widget.make', 'Widget.render', 'arrow', 'parseConfig'].sort(),
    );
    expect(byName.get('parseConfig')!.kind).toBe('function');
    expect(byName.get('Widget')!.kind).toBe('class');
    expect(byName.get('Widget.render')!.kind).toBe('method');
    // Line spans are 1-based.
    expect(byName.get('parseConfig')!.startLine).toBe(1);
  });

  test('qualifies nested names (Python method inside a class)', async () => {
    const ents = await extractEntities('class A:\n  def m(self):\n    pass', 'a.py');
    expect(ents!.map((e) => e.name).sort()).toEqual(['A', 'A.m']);
  });

  test('returns undefined for unsupported languages, [] for empty supported files', async () => {
    expect(await extractEntities('whatever', 'notes.md')).toBeUndefined();
    expect(await extractEntities('notes.txt content', 'a.unknownext')).toBeUndefined();
    expect(await extractEntities('const x = 1;', 'a.ts')).toEqual([]);
  });

  test('never throws on malformed source (returns best-effort)', async () => {
    const ents = await extractEntities('function broken( { { unterminated', 'a.ts');
    // Whatever it returns, it must not throw and must be an array or undefined.
    expect(Array.isArray(ents) || ents === undefined).toBe(true);
  });
});

describe('supportsEntities', () => {
  test('recognizes bundled languages and rejects others', () => {
    expect(supportsEntities('/x/y.ts')).toBe(true);
    expect(supportsEntities('main.py')).toBe(true);
    expect(supportsEntities('lib.rs')).toBe(true);
    expect(supportsEntities('README.md')).toBe(false);
    expect(supportsEntities('data.json')).toBe(false);
  });
});

// A representative fixture per bundled language: this guards every configured
// query — a wrong node name (e.g. after a grammar bump) makes the query throw
// and extraction return zero here, failing the test loudly instead of silently
// disabling that language in production.
const FIXTURES: Record<string, { file: string; code: string }> = {
  typescript: { file: 'a.ts', code: 'function foo(){}\nclass B{ m(){} }' },
  tsx: { file: 'a.tsx', code: 'function foo(){}\nclass B{ m(){} }' },
  javascript: { file: 'a.js', code: 'function foo(){}\nclass B{ m(){} }' },
  python: {
    file: 'a.py',
    code: 'def foo():\n  pass\nclass B:\n  def m(self):\n    pass',
  },
  go: { file: 'a.go', code: 'package m\nfunc Foo(){}\ntype T struct{}' },
  rust: { file: 'a.rs', code: 'fn foo(){}\nstruct S{}' },
  java: { file: 'A.java', code: 'class C{ void m(){} }' },
  c: { file: 'a.c', code: 'int foo(int a){return a;}' },
  cpp: { file: 'a.cpp', code: 'int foo(){return 0;}\nclass C{};' },
  c_sharp: { file: 'A.cs', code: 'class C{ void M(){} }' },
  ruby: { file: 'a.rb', code: 'def foo\nend\nclass Bar\nend' },
  php: { file: 'a.php', code: '<?php\nfunction foo(){}\nclass C{}' },
  swift: { file: 'a.swift', code: 'func foo(){}\nclass C{}' },
  kotlin: { file: 'a.kt', code: 'fun foo(){}\nclass C{}' },
  scala: { file: 'a.scala', code: 'def foo = 1\nclass C' },
  lua: { file: 'a.lua', code: 'function foo() end' },
  bash: { file: 'a.sh', code: 'foo(){ echo hi; }' },
};

describe('every bundled grammar extracts entities', () => {
  for (const lang of LANGUAGES) {
    test(`${lang.id} query captures at least one entity`, async () => {
      const fx = FIXTURES[lang.id];
      expect(fx).toBeDefined();
      const ents = await extractEntities(fx!.code, fx!.file);
      expect(ents).toBeDefined();
      expect(ents!.length).toBeGreaterThan(0);
    });
  }
});

describe('diffEntitiesDetailed', () => {
  const sig = (name: string, kind: string, hash: string) => ({
    name,
    kind,
    startLine: 1,
    endLine: 1,
    hash,
  });
  const names = (items: { name: string }[]) => items.map((i) => i.name);

  test('classifies added, changed, and removed by kind+name and body hash', () => {
    const prev = [sig('foo', 'function', 'h1'), sig('gone', 'function', 'h2')];
    const next = [sig('foo', 'function', 'CHANGED'), sig('added', 'function', 'h3')];
    const d = diffEntitiesDetailed(prev, next)!;
    expect(d.changed).toEqual([{ kind: 'function', name: 'foo' }]);
    expect(d.added).toEqual([{ kind: 'function', name: 'added' }]);
    expect(d.removed).toEqual([{ kind: 'function', name: 'gone' }]);
    expect(d.renamed).toEqual([]);
  });

  test('detects a rename (same kind + body hash) instead of add + remove', () => {
    const prev = [sig('parseCfg', 'function', 'SAME'), sig('keep', 'function', 'k')];
    const next = [sig('parseConfig', 'function', 'SAME'), sig('keep', 'function', 'k')];
    const d = diffEntitiesDetailed(prev, next)!;
    expect(d.renamed).toEqual([
      { kind: 'function', from: 'parseCfg', to: 'parseConfig' },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  test('a renamed-and-edited entity (hash differs) stays as add + remove', () => {
    const prev = [sig('old', 'function', 'h1')];
    const next = [sig('new', 'function', 'h2')];
    const d = diffEntitiesDetailed(prev, next)!;
    expect(d.renamed).toEqual([]);
    expect(names(d.added)).toEqual(['new']);
    expect(names(d.removed)).toEqual(['old']);
  });

  test('unchanged bodies produce an empty (but defined) change set', () => {
    const same = [sig('foo', 'function', 'h1')];
    const d = diffEntitiesDetailed(same, [sig('foo', 'function', 'h1')])!;
    expect(hasEntityChanges(d)).toBe(false);
  });

  test('first snapshot (no prior) lists all current entities as added', () => {
    const d = diffEntitiesDetailed(undefined, [
      sig('play', 'function', 'h1'),
      sig('main', 'function', 'h2'),
    ])!;
    expect(names(d.added)).toEqual(['main', 'play']);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.renamed).toEqual([]);
  });

  test('undefined only when the current snapshot has no entity data', () => {
    // Unsupported / uncaptured current side → nothing to show.
    expect(
      diffEntitiesDetailed([sig('foo', 'function', 'h')], undefined),
    ).toBeUndefined();
    expect(diffEntitiesDetailed(undefined, undefined)).toBeUndefined();
    // A supported-but-empty current file is "computed, nothing" (defined, empty).
    expect(hasEntityChanges(diffEntitiesDetailed(undefined, []))).toBe(false);
  });

  test('same name, different kind are distinct entities', () => {
    const prev = [sig('X', 'class', 'h1')];
    const next = [sig('X', 'function', 'h2')];
    const d = diffEntitiesDetailed(prev, next)!;
    expect(d.added).toEqual([{ kind: 'function', name: 'X' }]);
    expect(d.removed).toEqual([{ kind: 'class', name: 'X' }]);
    expect(d.changed).toEqual([]);
    expect(d.renamed).toEqual([]);
  });
});

describe('entityLabel', () => {
  test('adds call parens only for callable kinds', () => {
    expect(entityLabel({ name: 'foo', kind: 'function' })).toBe('foo()');
    expect(entityLabel({ name: 'A.m', kind: 'method' })).toBe('A.m()');
    expect(entityLabel({ name: 'Widget', kind: 'class' })).toBe('Widget');
    expect(entityLabel({ name: 'T', kind: 'struct' })).toBe('T');
  });
});

describe('report surfaces entity changes', () => {
  test('a second snapshot records what changed, and both renderers show it', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const file = join(dir, 'mod.ts');

      // Two turns, one edit each — a file edited across separate prompts is how
      // the report groups real work (one code change per turn).
      const t1 = await logEvent(author, { type: 'prompt', text: 'create the module' });
      writeFileSync(
        file,
        'export function foo(){ return 1 }\nclass Widget{ render(){} }\n',
      );
      await addArtifact(author, {
        filePath: 'mod.ts',
        turnId: t1.event.id,
        sessionId: t1.session.id,
      });

      const t2 = await logEvent(author, { type: 'prompt', text: 'revise the module' });
      writeFileSync(
        file,
        'export function foo(){ return 2 }\nclass Widget{}\nfunction bar(){}\n',
      );
      await addArtifact(author, {
        filePath: 'mod.ts',
        turnId: t2.event.id,
        sessionId: t2.session.id,
      });

      // t3: rename bar → initialize (identical body) — should surface as a rename.
      const t3 = await logEvent(author, { type: 'prompt', text: 'rename the helper' });
      writeFileSync(
        file,
        'export function foo(){ return 2 }\nclass Widget{}\nfunction initialize(){}\n',
      );
      await addArtifact(author, {
        filePath: 'mod.ts',
        turnId: t3.event.id,
        sessionId: t3.session.id,
      });

      const data = buildReportData(paths);
      const deltas = data.turns
        .flatMap((t) => t.codeChanges)
        .map((c) => c.entityChanges)
        .filter(hasEntityChanges);
      const names = (items: { name: string }[]) => items.map((i) => i.name);

      // The "create" turn (first snapshot, no prior): every entity shows as added.
      const create = deltas.find((d) => names(d.added).includes('Widget'))!;
      expect(create).toBeDefined();
      expect(names(create.added).sort()).toEqual(['Widget', 'Widget.render', 'foo']);
      expect(create.changed).toEqual([]);
      expect(create.removed).toEqual([]);

      // The "revise" turn: foo body changed, bar added, Widget.render removed.
      const revise = deltas.find((d) => names(d.changed).includes('foo'))!;
      expect(revise).toBeDefined();
      expect(revise.changed).toContainEqual({ kind: 'function', name: 'foo' });
      expect(names(revise.added)).toContain('bar');
      expect(names(revise.removed)).toContain('Widget.render');

      // The "rename" turn: bar → initialize as a single renamed row (no add/remove).
      const rename = deltas.find((d) => d.renamed.length > 0)!;
      expect(rename).toBeDefined();
      expect(rename.renamed).toContainEqual({
        kind: 'function',
        from: 'bar',
        to: 'initialize',
      });

      const html = renderHtml(data);
      expect(html).toContain('class="entity-changes"');
      expect(html).toContain('<code>foo</code>'); // kind-led, no parens
      expect(html).toContain('bar → initialize');
      expect(html).toContain('renamed');

      const md = renderMarkdown(data);
      expect(md).toContain('function `foo` — changed');
      expect(md).toContain('`bar → initialize` — renamed');
    } finally {
      cleanup(dir);
    }
  });

  test('a file edited twice in one turn keeps the later edit’s entity delta', async () => {
    const dir = makeTempDir();
    try {
      await runInit({ cwd: dir });
      const paths = pathsForRoot(dir);
      const author = authorFor(paths);
      const file = join(dir, 'x.ts');

      // Both edits land in one turn (same turnId) → the report collapses them to a
      // single code change. The first is the file's creation (no prior state → no
      // delta); the collapsed row must still surface the second edit's real delta.
      const t = await logEvent(author, { type: 'prompt', text: 'work' });
      writeFileSync(file, 'function a(){}\n');
      await addArtifact(author, {
        filePath: 'x.ts',
        turnId: t.event.id,
        sessionId: t.session.id,
      });
      writeFileSync(file, 'function a(){}\nfunction b(){}\n');
      await addArtifact(author, {
        filePath: 'x.ts',
        turnId: t.event.id,
        sessionId: t.session.id,
      });

      const data = buildReportData(paths);
      const changes = data.turns
        .flatMap((turn) => turn.codeChanges)
        .filter((c) => c.path === 'x.ts');
      expect(changes.length).toBe(1); // collapsed to one row
      expect(hasEntityChanges(changes[0]!.entityChanges)).toBe(true);
      expect(changes[0]!.entityChanges!.added.map((i) => i.name)).toContain('b');
    } finally {
      cleanup(dir);
    }
  });
});
