import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  decodeViewerHtml,
  renderViewerPayload,
  scanViewerHtml,
  splitViewerText,
  VIEWER_CHUNK_MAX_BYTES,
  VIEWER_PAGE_MAX_BYTES,
  VIEWER_PAGE_MAX_LINES,
  ViewerTextStoreBuilder,
  type ViewerEncodedChunk,
  type ViewerTextStore,
} from '../src/core/report/viewerCodec.ts';
import { buildManifest, verifySubmission } from '../src/core/submission.ts';
import { scanResidual } from '../src/core/sanitize.ts';
import { cleanup, makeTempDir } from './helpers.ts';

function fixture(texts: string[]) {
  const builder = new ViewerTextStoreBuilder();
  const refs = texts.map((text) => builder.add(text));
  const { store, blocks } = builder.finish();
  const index = {
    viewerPayloadVersion: 1,
    textStore: store,
    turns: refs.map((promptRef) => ({ promptRef })),
  };
  return { store, blocks, index, refs, html: renderViewerPayload(index, blocks) };
}

function changed(
  f: ReturnType<typeof fixture>,
  mutate: (store: ViewerTextStore, blocks: ViewerEncodedChunk[]) => void,
): string {
  const store = structuredClone(f.store);
  const blocks = structuredClone(f.blocks);
  mutate(store, blocks);
  return renderViewerPayload({ ...f.index, textStore: store }, blocks);
}

describe('standalone viewer text transport', () => {
  test('round-trips exact text and interns repeated logical text and pages', () => {
    const texts = [
      '',
      'same prompt',
      'same prompt',
      "</script><script>alert(1)</script> $& $` $' \r\n 😀 \uD800",
    ];
    const f = fixture(texts);
    const result = decodeViewerHtml(f.html)!;
    expect(f.refs[1]).toBe(f.refs[2]);
    expect(result.texts.size).toBe(3);
    for (let i = 0; i < texts.length; i++)
      expect(result.texts.get(f.refs[i]!)).toBe(texts[i]);
    expect(f.html).not.toContain('</script><script>alert(1)');
    const builder = new ViewerTextStoreBuilder();
    const first = builder.add('a'.repeat(VIEWER_PAGE_MAX_BYTES) + 'first');
    const second = builder.add('a'.repeat(VIEWER_PAGE_MAX_BYTES) + 'second');
    const { store } = builder.finish();
    expect(store.refs[first]!.pages[0]).toBe(store.refs[second]!.pages[0]);
    expect(() => builder.add('late')).toThrow('already finished');
    expect(builder.finish().store).toBe(store);
  });

  test('bounds pages by UTF8 bytes and line count without splitting a surrogate pair', () => {
    for (const text of [
      'row\r\n'.repeat(1500),
      '😀'.repeat(40000),
      '漢'.repeat(40000),
      'a'.repeat(VIEWER_PAGE_MAX_BYTES - 1) + '😀' + 'b'.repeat(60000),
      '\uD800'.repeat(40000),
    ]) {
      const pages = splitViewerText(text);
      expect(pages.join('')).toBe(text);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        expect(Buffer.byteLength(page, 'utf8')).toBeLessThanOrEqual(
          VIEWER_PAGE_MAX_BYTES,
        );
        expect(page.split('\n').length).toBeLessThanOrEqual(VIEWER_PAGE_MAX_LINES);
      }
      if (!text.includes('\uD800'))
        for (let i = 1; i < pages.length; i++) {
          expect(/^[\uDC00-\uDFFF]/.test(pages[i]!)).toBe(false);
          expect(/[\uD800-\uDBFF]$/.test(pages[i - 1]!)).toBe(false);
        }
      expect(decodeViewerHtml(fixture([text]).html)!.texts.get('t0')).toBe(text);
    }
  });

  test('packs escaped page maps into independently bounded gzip chunks', () => {
    const text = Array.from(
      { length: 80 },
      (_, i) => `${i}:` + '\u0000"\\'.repeat(15000),
    ).join('\n');
    const f = fixture([text]);
    expect(f.blocks.length).toBeGreaterThan(2);
    for (const block of f.blocks) {
      const decoded = gunzipSync(Buffer.from(block.data, 'base64'));
      expect(decoded.length).toBeLessThanOrEqual(VIEWER_CHUNK_MAX_BYTES);
      expect(f.store.chunks[block.id]!.decodedBytes).toBe(decoded.length);
      expect(f.store.chunks[block.id]!.encodedBytes).toBe(block.data.length);
    }
    expect(decodeViewerHtml(f.html)!.texts.get('t0')).toBe(text);
  });

  test('escapes metadata script closures and does not interpret the static worker as payload', () => {
    const f = fixture(['ordinary']);
    const html =
      renderViewerPayload(
        { ...f.index, title: '</script><script>alert(1)</script>' },
        f.blocks,
      ) +
      '<script id="st-report-worker" type="application/octet-stream">trusted worker source</script>';
    expect(html).toContain('\\u003c/script>');
    expect(decodeViewerHtml(html)!.index.title).toBe(
      '</script><script>alert(1)</script>',
    );
  });

  test('scans complete logical texts across page boundaries and late chunks', () => {
    const split =
      'x'.repeat(VIEWER_PAGE_MAX_BYTES - 4) + 'api_key=deliberatelyFakeCredential123';
    const f = fixture([
      'ordinary first page',
      Array.from({ length: 16000 }, (_, i) => `earlier unique row ${i}\n`).join(''),
      split,
    ]);
    expect(f.blocks.length).toBeGreaterThan(1);
    expect(f.store.refs[f.refs[2]!]!.pages.length).toBeGreaterThan(1);
    const rawPages = Object.assign(
      {},
      ...f.blocks.map((block) =>
        JSON.parse(gunzipSync(Buffer.from(block.data, 'base64')).toString('utf8')),
      ),
    ) as Record<string, string>;
    for (const id of f.store.refs[f.refs[2]!]!.pages)
      expect(scanResidual(rawPages[id]!, { structural: true })).toEqual([]);
    expect(
      scanViewerHtml(f.html).some((finding) => finding.kind === 'assigned-secret'),
    ).toBe(true);
    const metadataSecret = renderViewerPayload(
      { ...f.index, label: 'Bearer deliberatelyFakeToken123' },
      f.blocks,
    );
    expect(
      scanViewerHtml(metadataSecret).some((finding) => finding.kind === 'bearer'),
    ).toBe(true);
    expect(scanViewerHtml(fixture(['All ordinary text.']).html)).toEqual([]);
  });

  test('does not mistake encoded transport and CSP digests for plaintext secrets', () => {
    const f = fixture(['Clean content']);
    const html = `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-AKIA1234567890000000'">${f.html}`;
    expect(scanViewerHtml(html)).toEqual([]);
    expect(scanViewerHtml(html.replaceAll("'", '&#39;'))).toEqual([]);
    expect(scanViewerHtml("<p>'sha256-AKIA1234567890000000'</p>").length).toBeGreaterThan(
      0,
    );
    expect(
      scanViewerHtml('<p>api_key=deliberatelyFakeCredential123</p>').length,
    ).toBeGreaterThan(0);
    expect(decodeViewerHtml('<html><body>legacy plain report</body></html>')).toBeNull();
  });

  test('rejects truncated, duplicate and unsupported payload manifests instead of treating them as legacy', () => {
    const f = fixture(['clean']);
    for (const html of [
      '<script id="st-report-manifest" type="application/json">{',
      '<script id="st-report-manifest',
      '<script data-st-chunk="c0">AAAA</script>',
      f.html + f.html,
      f.html.replace('"viewerPayloadVersion":1', '"viewerPayloadVersion":9'),
      f.html.replace('"version":1', '"version":9'),
      f.html.replace('"promptRef":"t0"', '"promptRef":"t999"'),
      f.html.replace('type="application/json"', 'type="text/javascript"'),
    ])
      expect(() => decodeViewerHtml(html)).toThrow('Invalid HTML viewer payload');
  });

  test('rejects missing or duplicate blocks, invalid base64, length mismatches and invalid page references', () => {
    const f = fixture(['clean']);
    const malformed = [
      changed(f, (_s, blocks) => {
        blocks.length = 0;
      }),
      changed(f, (_s, blocks) => {
        blocks.push(blocks[0]!);
      }),
      changed(f, (_s, blocks) => {
        blocks[0]!.data = 'AAAA';
      }),
      changed(f, (s) => {
        s.chunks.c0!.decodedBytes++;
      }),
      changed(f, (s) => {
        s.chunks.c0!.encodedBytes++;
      }),
      changed(f, (s) => {
        s.pages.p0!.bytes++;
      }),
      changed(f, (s) => {
        s.pages.p0!.lines++;
      }),
      changed(f, (s) => {
        s.refs.t0!.pages = ['p999'];
      }),
      changed(f, (s) => {
        s.refs.t0!.bytes++;
      }),
      changed(f, (s) => {
        s.refs.t0!.lines++;
      }),
      changed(f, (s) => {
        delete s.refs.t0;
      }),
    ];
    for (const html of malformed)
      expect(() => scanViewerHtml(html)).toThrow('Invalid HTML viewer payload');
  });

  test('rejects an oversized gzip body before trusting its declared small size', () => {
    const f = fixture(['clean']);
    const html = changed(f, (store, blocks) => {
      blocks[0]!.data = gzipSync(
        Buffer.from(' '.repeat(VIEWER_CHUNK_MAX_BYTES + 1)),
      ).toString('base64');
      store.chunks.c0!.encodedBytes = blocks[0]!.data.length;
    });
    expect(() => decodeViewerHtml(html)).toThrow('cannot be safely decompressed');
  });

  test('rejects undeclared content in a correctly encoded chunk', () => {
    const f = fixture(['clean']);
    const html = changed(f, (store, blocks) => {
      const json = JSON.stringify({
        p0: 'clean',
        hidden: 'api_key=deliberatelyFakeCredential123',
      });
      blocks[0]!.data = gzipSync(Buffer.from(json)).toString('base64');
      store.chunks.c0 = {
        decodedBytes: Buffer.byteLength(json),
        encodedBytes: blocks[0]!.data.length,
      };
    });
    expect(() => decodeViewerHtml(html)).toThrow('unknown or duplicate page');
  });

  test('rejects duplicate JSON keys instead of dropping hidden earlier strings', () => {
    const f = fixture(['clean']);
    const hidden = changed(f, (store, blocks) => {
      const json = '{"p0":"api_key=deliberatelyFakeCredential123","p0":"clean"}';
      blocks[0]!.data = gzipSync(Buffer.from(json)).toString('base64');
      store.chunks.c0 = {
        decodedBytes: Buffer.byteLength(json),
        encodedBytes: blocks[0]!.data.length,
      };
    });
    expect(() => scanViewerHtml(hidden)).toThrow('not a JSON page map');
    const metadata = f.html.replace(
      '"viewerPayloadVersion":1',
      '"label":"api_key=deliberatelyFakeCredential123","label":"clean","viewerPayloadVersion":1',
    );
    expect(() => scanViewerHtml(metadata)).toThrow('not valid JSON');
  });

  test('validates and scans item metadata hidden inside logical JSON text storage', () => {
    const builder = new ViewerTextStoreBuilder();
    const bodyRef = builder.add('Clean body');
    const itemsRef = builder.add(
      JSON.stringify([{ id: 'item', textRef: bodyRef, title: 'ordinary' }]),
    );
    const encoded = builder.finish();
    const index = {
      viewerPayloadVersion: 1,
      textStore: encoded.store,
      turns: [{ itemsRef }],
    };
    const good = renderViewerPayload(index, encoded.blocks);
    expect(decodeViewerHtml(good)!.structuredTexts.has(itemsRef)).toBe(true);
    expect(scanViewerHtml(good)).toEqual([]);
    const providerMetadata = new ViewerTextStoreBuilder();
    const providerBody = providerMetadata.add('Clean native body');
    const providerItems = providerMetadata.add(
      JSON.stringify([
        {
          id: 'item',
          textRef: providerBody,
          evidence: [
            {
              providerMetadata: {
                textRef: 'provider-reference',
                itemsRef: 'provider-reference',
              },
            },
          ],
        },
      ]),
    );
    const providerStore = providerMetadata.finish();
    const providerHtml = renderViewerPayload(
      {
        viewerPayloadVersion: 1,
        textStore: providerStore.store,
        turns: [{ itemsRef: providerItems }],
      },
      providerStore.blocks,
    );
    expect(() => decodeViewerHtml(providerHtml)).not.toThrow();
    const broken = new ViewerTextStoreBuilder();
    const brokenRef = broken.add('[{"id":"item","textRef":"t999"}]');
    const bad = broken.finish();
    expect(() =>
      decodeViewerHtml(
        renderViewerPayload(
          {
            viewerPayloadVersion: 1,
            textStore: bad.store,
            turns: [{ itemsRef: brokenRef }],
          },
          bad.blocks,
        ),
      ),
    ).toThrow('unknown text reference');
    const secret = new ViewerTextStoreBuilder();
    const secretRef = secret.add(
      '[{"title":"\\u0061pi_key=deliberatelyFakeCredential123"}]',
    );
    const hidden = secret.finish();
    expect(
      scanViewerHtml(
        renderViewerPayload(
          {
            viewerPayloadVersion: 1,
            textStore: hidden.store,
            turns: [{ itemsRef: secretRef }],
          },
          hidden.blocks,
        ),
      ).some((finding) => finding.kind === 'assigned-secret'),
    ).toBe(true);
  });
});

function signedExport(dir: string, html: string, markdown = 'Ordinary report\n'): void {
  mkdirSync(dir, { recursive: true });
  const { manifestJson, signature } = buildManifest({
    html,
    markdown,
    scope: null,
    summary: { sessions: 1, events: 1, artifacts: 0, turns: 1 },
    withheld: { total: 0, byLabel: {} },
    scanFindings: 0,
  });
  writeFileSync(join(dir, 'report.html'), html);
  writeFileSync(join(dir, 'report.md'), markdown);
  writeFileSync(join(dir, 'manifest.json'), manifestJson);
  writeFileSync(join(dir, 'manifest.sig'), signature);
}

describe('submission verification of standalone payloads', () => {
  test('preserves manifest format and signed bytes for both lazy and legacy reports', () => {
    const dir = makeTempDir();
    const previous = process.env.SHOWTAIL_HOME;
    process.env.SHOWTAIL_HOME = join(dir, 'home');
    try {
      for (const html of [
        fixture(['All ordinary text']).html,
        '<html><p>Legacy plain report</p></html>',
      ]) {
        const output = join(dir, 'export');
        signedExport(output, html);
        const result = verifySubmission(output);
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.manifest?.format).toBe(1);
        expect(result.manifest?.scan.scanner).toBe('showtail-residual-2');
      }
      const output = join(dir, 'export');
      writeFileSync(
        join(output, 'report.html'),
        readFileSync(join(output, 'report.html'), 'utf8') + '<!-- changed -->',
      );
      expect(verifySubmission(output).problems).toContain(
        'report.html was changed after signing',
      );
    } finally {
      if (previous === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previous;
      cleanup(dir);
    }
  });

  test('fails fresh verification for a signed compressed hidden secret or malformed payload', () => {
    const dir = makeTempDir();
    const previous = process.env.SHOWTAIL_HOME;
    process.env.SHOWTAIL_HOME = join(dir, 'home');
    try {
      const output = join(dir, 'export');
      signedExport(
        output,
        fixture(['first clean', 'api_key=deliberatelyFakeCredential123']).html,
      );
      const secret = verifySubmission(output);
      expect(secret.ok).toBe(false);
      expect(
        secret.problems.some((problem) => problem.includes('report.html still contains')),
      ).toBe(true);
      signedExport(
        output,
        '<script id="st-report-manifest" type="application/json">{</script>',
      );
      const malformed = verifySubmission(output);
      expect(malformed.ok).toBe(false);
      expect(
        malformed.problems.some((problem) =>
          problem.includes('could not be safely inspected'),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SHOWTAIL_HOME;
      else process.env.SHOWTAIL_HOME = previous;
      cleanup(dir);
    }
  });
});
