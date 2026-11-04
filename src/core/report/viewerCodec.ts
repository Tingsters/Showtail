/** The private transport used by the standalone HTML viewer, not ReportData's schema. */
import { gzipSync, gunzipSync } from 'node:zlib';
import { scanResidual, type Finding } from '../sanitize.ts';

export const VIEWER_PAYLOAD_VERSION = 1;
export const VIEWER_PAGE_MAX_BYTES = 32 * 1024;
export const VIEWER_PAGE_MAX_LINES = 200;
export const VIEWER_CHUNK_MAX_BYTES = 256 * 1024;
export const VIEWER_METADATA_MAX_BYTES = 32 * 1024 * 1024;
export const VIEWER_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
const ENCODED_CHUNK_MAX_BYTES = Math.ceil((VIEWER_CHUNK_MAX_BYTES + 1024) / 3) * 4;
const MANIFEST_ID = 'st-report-manifest';

export interface ViewerTextRef {
  pages: string[];
  bytes: number;
  lines: number;
}
export interface ViewerTextPage {
  chunk: string;
  bytes: number;
  lines: number;
}
export interface ViewerChunkDescriptor {
  decodedBytes: number;
  /** Number of ASCII bytes in the base64 text, not the compressed binary. */
  encodedBytes: number;
}
export interface ViewerTextStore {
  version: 1;
  refs: Record<string, ViewerTextRef>;
  pages: Record<string, ViewerTextPage>;
  chunks: Record<string, ViewerChunkDescriptor>;
}
export interface ViewerEncodedChunk {
  id: string;
  data: string;
}
export interface ViewerTextStoreResult {
  store: ViewerTextStore;
  blocks: ViewerEncodedChunk[];
}
export interface DecodedViewerHtml {
  index: Record<string, unknown> & {
    viewerPayloadVersion: 1;
    textStore: ViewerTextStore;
  };
  /** Complete logical texts, reassembled before independent privacy scanning. */
  texts: Map<string, string>;
  /** Metadata moved into text storage is still validated and scanned as JSON. */
  structuredTexts: Map<string, unknown>;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
function lines(text: string): number {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** Split without losing any characters, including CRLF and unpaired surrogates. */
export function splitViewerText(text: string): string[] {
  if (!text) return [''];
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + VIEWER_PAGE_MAX_BYTES);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    if (byteLength(text.slice(start, end)) > VIEWER_PAGE_MAX_BYTES) {
      let lo = start + 1;
      let hi = end;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (byteLength(text.slice(start, mid)) <= VIEWER_PAGE_MAX_BYTES) lo = mid;
        else hi = mid - 1;
      }
      end = lo;
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    let newline = start - 1;
    for (let n = 1; n < VIEWER_PAGE_MAX_LINES; n++) {
      const next = text.indexOf('\n', newline + 1);
      if (next === -1 || next >= end) break;
      newline = next;
      if (n === VIEWER_PAGE_MAX_LINES - 1) end = newline + 1;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages;
}

/** Intern complete texts and identical pages; gzip independent bounded page maps. */
export class ViewerTextStoreBuilder {
  private readonly interned = new Map<string, string>();
  private readonly pageIds = new Map<string, string>();
  private readonly refs: Record<string, ViewerTextRef> = {};
  private readonly rawPages: Array<[string, string]> = [];
  private totalBytes = 0;
  private result?: ViewerTextStoreResult;

  add(text: string): string {
    if (this.result) throw new Error('The viewer text store is already finished');
    const existing = this.interned.get(text);
    if (existing !== undefined) return existing;
    const bytes = byteLength(text);
    if (this.totalBytes + bytes > VIEWER_TOTAL_MAX_BYTES)
      throw new Error('The HTML viewer text exceeds the 512 MiB safety limit');
    this.totalBytes += bytes;
    const id = `t${this.interned.size}`;
    const pages = splitViewerText(text).map((page) => {
      let pageId = this.pageIds.get(page);
      if (pageId === undefined) {
        pageId = `p${this.rawPages.length}`;
        this.pageIds.set(page, pageId);
        this.rawPages.push([pageId, page]);
      }
      return pageId;
    });
    this.refs[id] = { pages, bytes, lines: lines(text) };
    this.interned.set(text, id);
    return id;
  }

  finish(): ViewerTextStoreResult {
    if (this.result) return this.result;
    const store: ViewerTextStore = { version: 1, refs: this.refs, pages: {}, chunks: {} };
    const blocks: ViewerEncodedChunk[] = [];
    let entries: Array<[string, string]> = [];
    let size = 2;
    let decodedTotal = 0;
    const flush = () => {
      if (!entries.length) return;
      const id = `c${blocks.length}`;
      const json = JSON.stringify(Object.fromEntries(entries));
      decodedTotal += byteLength(json);
      if (decodedTotal > VIEWER_TOTAL_MAX_BYTES)
        throw new Error('The HTML viewer chunks exceed the 512 MiB safety limit');
      const data = gzipSync(Buffer.from(json, 'utf8')).toString('base64');
      store.chunks[id] = { decodedBytes: byteLength(json), encodedBytes: data.length };
      for (const [pageId, text] of entries)
        store.pages[pageId] = { chunk: id, bytes: byteLength(text), lines: lines(text) };
      blocks.push({ id, data });
      entries = [];
      size = 2;
    };
    for (const entry of this.rawPages) {
      const pairSize =
        byteLength(JSON.stringify(entry[0])) + 1 + byteLength(JSON.stringify(entry[1]));
      if (size + pairSize + (entries.length ? 1 : 0) > VIEWER_CHUNK_MAX_BYTES) flush();
      if (pairSize + 2 > VIEWER_CHUNK_MAX_BYTES)
        throw new Error('An HTML viewer page exceeds its chunk limit');
      size += pairSize + (entries.length ? 1 : 0);
      entries.push(entry);
    }
    flush();
    this.result = { store, blocks };
    return this.result;
  }
}

/** All captured strings are JSON data, never executable scripts or replacement strings. */
export function renderViewerPayload(index: object, blocks: ViewerEncodedChunk[]): string {
  const json = JSON.stringify(index).replace(/</g, '\\u003c');
  if (byteLength(json) > VIEWER_METADATA_MAX_BYTES)
    throw new Error('The HTML viewer index exceeds its safety limit');
  return (
    `<script id="${MANIFEST_ID}" type="application/json">${json}</script>\n` +
    blocks
      .map(({ id, data }) => {
        if (!/^c(?:0|[1-9]\d*)$/.test(id) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
          throw new Error('Invalid HTML viewer chunk encoding');
        return `<script type="application/octet-stream" data-st-chunk="${id}">${data}</script>`;
      })
      .join('\n')
  );
}

function fail(message: string): never {
  throw new Error(`Invalid HTML viewer payload: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(`${label} is out of bounds`);
  return value as number;
}
function fields(value: Record<string, unknown>, names: string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...names].sort().join(','))
    fail(`${label} has unexpected fields`);
}
function safeIds(value: Record<string, unknown>, prefix: string, label: string): void {
  const pattern = new RegExp(`^${prefix}(?:0|[1-9]\\d*)$`);
  if (Object.keys(value).some((id) => !pattern.test(id)))
    fail(`${label} has an invalid id`);
}
/** JSON.parse otherwise silently discards earlier values with the same key. */
function parseJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (const match of source.matchAll(
    /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g,
  )) {
    const token = match[0];
    if (token === '{' || token === '[')
      stack.push({ object: token === '{', key: token === '{', keys: new Set() });
    else if (token === '}' || token === ']') stack.pop();
    else {
      const frame = stack[stack.length - 1];
      if (!frame?.object) continue;
      if (token === ',') frame.key = true;
      else if (token === ':') frame.key = false;
      else if (frame.key && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (frame.keys.has(key)) fail('duplicate JSON object key');
        frame.keys.add(key);
      }
    }
  }
  return value;
}
function attrValue(value: string): string {
  return value.replace(
    /&#(?:x([0-9a-f]+)|(\d+));?|&(amp|quot|apos|lt|gt);/gi,
    (m, hex, dec, name) => {
      if (hex || dec) {
        const n = Number.parseInt(hex ?? dec, hex ? 16 : 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD';
      }
      return (
        ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[
          String(name).toLowerCase()
        ] ?? m
      );
    },
  );
}
function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const attribute = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(attribute)) {
    const name = match[1]!.toLowerCase();
    if (result.has(name)) fail('duplicate script attribute');
    result.set(name, attrValue(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}
interface PayloadScript {
  attributes: Map<string, string>;
  body: string;
  start: number;
  end: number;
}
function payloadScripts(html: string): PayloadScript[] {
  const result: PayloadScript[] = [];
  // Recognize browser-tolerated end tags before rejecting noncanonical payload
  // delimiters. End-tag attributes must never become uninspected transport bytes.
  for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)(<\/script\b[^>]*>)/gi)) {
    const attrs = attributes(tag[1]!);
    if (attrs.get('id') === MANIFEST_ID || attrs.has('data-st-chunk')) {
      if (!/^[\t\n\f\r ]*$/.test(tag[3]!.slice(8, -1)))
        fail('payload script closing tags must not have attributes or a slash');
      result.push({
        attributes: attrs,
        body: tag[2]!,
        start: tag.index!,
        end: tag.index! + tag[0].length,
      });
    }
  }
  // An opening payload tag without a matching close must not silently become legacy HTML.
  let markers = 0;
  for (const tag of html.matchAll(/<script\b([^>]*)(?:>|$)/gi)) {
    const attrs = attributes(tag[1]!);
    if (
      attrs.get('id') === MANIFEST_ID ||
      attrs.has('data-st-chunk') ||
      /\bid\s*=\s*["']?st-report-manifest\b/i.test(tag[1]!)
    )
      markers++;
  }
  if (markers !== result.length) fail('an embedded payload script is incomplete');
  return result;
}

/** Decode without evaluating HTML/JavaScript. Native zlib bounds each inflated chunk. */
export function decodeViewerHtml(html: string): DecodedViewerHtml | null {
  const scripts = payloadScripts(html);
  if (!scripts.length) return null;
  const manifests = scripts.filter((s) => s.attributes.get('id') === MANIFEST_ID);
  if (manifests.length !== 1) fail('exactly one manifest is required');
  const manifest = manifests[0]!;
  if (
    manifest.attributes.get('type') !== 'application/json' ||
    manifest.attributes.has('data-st-chunk')
  )
    fail('invalid manifest script');
  if (byteLength(manifest.body) > VIEWER_METADATA_MAX_BYTES)
    fail('metadata exceeds its limit');
  let index: Record<string, unknown>;
  try {
    index = object(parseJson(manifest.body), 'index');
  } catch {
    fail('the manifest is not valid JSON');
  }
  if (index.viewerPayloadVersion !== VIEWER_PAYLOAD_VERSION)
    fail('unsupported viewer version');
  const source = object(index.textStore, 'textStore');
  fields(source, ['version', 'refs', 'pages', 'chunks'], 'textStore');
  if (source.version !== 1) fail('unsupported text store version');
  const refs = object(source.refs, 'refs');
  const pages = object(source.pages, 'pages');
  const chunks = object(source.chunks, 'chunks');
  safeIds(refs, 't', 'refs');
  safeIds(pages, 'p', 'pages');
  safeIds(chunks, 'c', 'chunks');
  const blocks = new Map<string, PayloadScript>();
  for (const script of scripts) {
    if (script === manifest) continue;
    const id = script.attributes.get('data-st-chunk')!;
    if (
      script.attributes.get('type') !== 'application/octet-stream' ||
      !Object.hasOwn(chunks, id) ||
      blocks.has(id)
    )
      fail('unknown, duplicate or invalid chunk script');
    blocks.set(id, script);
  }
  if (blocks.size !== Object.keys(chunks).length) fail('a chunk is missing');
  const rawPages = new Map<string, string>();
  let decodedTotal = 0;
  for (const [id, value] of Object.entries(chunks)) {
    const descriptor = object(value, `chunk ${id}`);
    fields(descriptor, ['decodedBytes', 'encodedBytes'], `chunk ${id}`);
    const decodedBytes = integer(
      descriptor.decodedBytes,
      VIEWER_CHUNK_MAX_BYTES,
      `chunk ${id} decoded bytes`,
      2,
    );
    const encodedBytes = integer(
      descriptor.encodedBytes,
      ENCODED_CHUNK_MAX_BYTES,
      `chunk ${id} encoded bytes`,
      4,
    );
    decodedTotal += decodedBytes;
    if (decodedTotal > VIEWER_TOTAL_MAX_BYTES)
      fail('decoded chunks exceed the total limit');
    const data = blocks.get(id)!.body.trim();
    if (
      data.length !== encodedBytes ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      fail(`chunk ${id} base64 is invalid`);
    const compressed = Buffer.from(data, 'base64');
    if (compressed.toString('base64') !== data)
      fail(`chunk ${id} base64 is not canonical`);
    let decoded: Buffer;
    try {
      decoded = gunzipSync(compressed, { maxOutputLength: VIEWER_CHUNK_MAX_BYTES });
    } catch {
      fail(`chunk ${id} cannot be safely decompressed`);
    }
    const json = decoded.toString('utf8');
    if (decoded.length !== decodedBytes || !Buffer.from(json, 'utf8').equals(decoded))
      fail(`chunk ${id} byte length or UTF8 is invalid`);
    let values: Record<string, unknown>;
    try {
      values = object(parseJson(json), `chunk ${id}`);
    } catch {
      fail(`chunk ${id} is not a JSON page map`);
    }
    if (!Object.keys(values).length) fail(`chunk ${id} is empty`);
    for (const [pageId, text] of Object.entries(values)) {
      if (
        !Object.hasOwn(pages, pageId) ||
        rawPages.has(pageId) ||
        typeof text !== 'string'
      )
        fail(`chunk ${id} contains an unknown or duplicate page`);
      const page = object(pages[pageId], `page ${pageId}`);
      fields(page, ['chunk', 'bytes', 'lines'], `page ${pageId}`);
      if (
        page.chunk !== id ||
        integer(page.bytes, VIEWER_PAGE_MAX_BYTES, `page ${pageId} bytes`) !==
          byteLength(text) ||
        integer(page.lines, VIEWER_PAGE_MAX_LINES, `page ${pageId} lines`, 1) !==
          lines(text)
      )
        fail(`page ${pageId} metadata does not match its text`);
      rawPages.set(pageId, text);
    }
  }
  if (rawPages.size !== Object.keys(pages).length) fail('a page is missing');
  const texts = new Map<string, string>();
  const usedPages = new Set<string>();
  let logicalTotal = 0;
  for (const [id, value] of Object.entries(refs)) {
    const ref = object(value, `ref ${id}`);
    fields(ref, ['pages', 'bytes', 'lines'], `ref ${id}`);
    const bytes = integer(ref.bytes, VIEWER_TOTAL_MAX_BYTES, `ref ${id} bytes`);
    logicalTotal += bytes;
    if (logicalTotal > VIEWER_TOTAL_MAX_BYTES)
      fail('logical texts exceed the total limit');
    if (
      !Array.isArray(ref.pages) ||
      !ref.pages.length ||
      ref.pages.some((p) => typeof p !== 'string' || !rawPages.has(p))
    )
      fail(`ref ${id} has an unknown page`);
    const pageIds = ref.pages as string[];
    // Check the declared size before joining, including repeated page references.
    const actualBytes = pageIds.reduce(
      (sum, p) => sum + (pages[p] as ViewerTextPage).bytes,
      0,
    );
    if (actualBytes !== bytes) fail(`ref ${id} byte length does not match`);
    const text = pageIds
      .map((p) => {
        usedPages.add(p);
        return rawPages.get(p)!;
      })
      .join('');
    if (
      integer(ref.lines, VIEWER_TOTAL_MAX_BYTES + 1, `ref ${id} lines`, 1) !== lines(text)
    )
      fail(`ref ${id} line count does not match`);
    texts.set(id, text);
  }
  if (usedPages.size !== rawPages.size) fail('an unreferenced page is embedded');
  // Validate references at the DTO positions the viewer actually loads. Raw
  // provider/evidence objects may use the same names for unrelated identities.
  const pending: Array<{ value: unknown; kind: 'turn' | 'item' }> = [];
  const addRows = (value: unknown, label: string, kind: 'turn' | 'item') => {
    if (value === undefined) return;
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    for (const row of value) pending.push({ value: row, kind });
  };
  addRows(index.turns, 'turns', 'turn');
  addRows(index.unlinked, 'unlinked', 'turn');
  addRows(index.observations, 'observations', 'item');
  addRows(index.plans, 'plans', 'item');
  if (index.items !== undefined)
    for (const value of Object.values(object(index.items, 'items')))
      pending.push({ value, kind: 'item' });
  const structuredTexts = new Map<string, unknown>();
  while (pending.length) {
    const { value, kind } = pending.pop()!;
    const row = object(value, kind);
    if (
      row.rawRefs !== undefined &&
      (!Array.isArray(row.rawRefs) ||
        row.rawRefs.some((ref) => typeof ref !== 'string' || !texts.has(ref)))
    )
      fail('unknown raw provider text reference');
    for (const key of kind === 'turn'
      ? ['promptRef', 'itemsRef', 'recapRef']
      : ['textRef', 'resultRef']) {
      const ref = row[key];
      if (ref === undefined || ref === null) continue;
      if (typeof ref !== 'string' || !texts.has(ref))
        fail(`unknown text reference ${key}`);
      if (key !== 'itemsRef' || structuredTexts.has(ref)) continue;
      let metadata: unknown;
      try {
        metadata = parseJson(texts.get(ref)!);
      } catch {
        fail('embedded item metadata is not valid JSON');
      }
      if (
        !Array.isArray(metadata) ||
        metadata.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
      )
        fail('embedded item metadata must be an array of records');
      structuredTexts.set(ref, metadata);
      for (const item of metadata) pending.push({ value: item, kind: 'item' });
    }
  }
  return { index: index as DecodedViewerHtml['index'], texts, structuredTexts };
}

/** Independently inspect all logical content, even unloaded pages and split secrets. */
export function scanViewerHtml(html: string): Finding[] {
  const decoded = decodeViewerHtml(html);
  const counts = new Map<string, number>();
  const scan = (text: string) => {
    for (const finding of scanResidual(text, { structural: true }))
      counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + finding.count);
  };
  const scanMetadata = (value: unknown) => {
    // Counts are typed numbers, not credentials. Normalize only known numeric
    // usage fields for the generic assignment heuristic; every string and any
    // other secret-shaped assignment is still independently inspected below.
    const usageCount =
      /^(?:total)?(?:inputTokens|outputTokens|cacheReadTokens|cacheCreationTokens|tokenCount)$/i;
    scan(
      JSON.stringify(
        value,
        (key, item) =>
          usageCount.test(key) &&
          typeof item === 'number' &&
          Number.isFinite(item) &&
          item >= 0
            ? 0
            : item,
        2,
      ),
    );
  };
  // Encoded gzip/base64 and generated CSP digests are transport bytes, not plaintext secrets.
  // Every decoded block is validated and scanned separately below.
  const scripts = decoded ? payloadScripts(html) : [];
  let outer = '';
  let from = 0;
  for (const script of scripts) {
    outer += html.slice(from, script.start);
    from = script.end;
  }
  outer += html.slice(from);
  outer = outer.replace(/<meta\b[^>]*>/gi, (tag) => {
    const attrs = attributes(tag.slice(5, -1));
    if (attrs.get('http-equiv')?.toLowerCase() !== 'content-security-policy') return tag;
    return [...attrs]
      .map(
        ([key, value]) =>
          `${key}="${value.replace(/'(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}'/g, "'csp-digest'")}"`,
      )
      .join(' ');
  });
  scan(outer);
  if (decoded) {
    scanMetadata(decoded.index);
    for (const text of decoded.texts.values()) scan(text);
    const pending: unknown[] = [decoded.index];
    for (const metadata of decoded.structuredTexts.values()) {
      scanMetadata(metadata);
      pending.push(metadata);
    }
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === 'string') scan(item);
      else if (item && typeof item === 'object') {
        for (const [key, value] of Object.entries(item)) {
          scan(key);
          pending.push(value);
        }
      }
    }
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
