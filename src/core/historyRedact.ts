import { HistoryStore, canonical, digest, historySettings } from './history.ts';
import { redact } from './redact.ts';

/** Explicit privacy transformations readdress content and declare the rewrite. */
export function redactHistory(
  store: HistoryStore,
  options: { pattern?: string; apply?: boolean } = {},
): { objects: number; values: number; applied: boolean } {
  const expression = options.pattern ? new RegExp(options.pattern, 'g') : undefined;
  const changes = new Map<string, { hash: string; content: string; hits: number }>();
  const structured = new Set(
    (store.query('SELECT payload FROM records').all() as { payload: string }[]).flatMap(
      (r) => {
        const p = JSON.parse(r.payload);
        return p.conversationRef ? [p.conversationRef] : [];
      },
    ),
  );
  for (const object of store.query('SELECT hash,content FROM objects').all() as {
    hash: string;
    content: string;
  }[]) {
    let hits = 0;
    const scrub = (text: string): string => {
      if (expression)
        return text.replace(expression, () => {
          hits++;
          return '[redacted]';
        });
      const result = redact(text, {
        ...historySettings().redact,
        enabled: true,
        secrets: true,
        pii: true,
      });
      hits += result.hits;
      return result.text;
    };
    const visit = (v: any): any =>
      typeof v === 'string'
        ? scrub(v)
        : Array.isArray(v)
          ? v.map(visit)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, visit(value)]))
            : v;
    const content = structured.has(object.hash)
      ? canonical(visit(JSON.parse(object.content)))
      : scrub(object.content);
    if (content !== object.content)
      changes.set(object.hash, { hash: digest(content), content, hits });
  }
  const values = [...changes.values()].reduce((n, c) => n + c.hits, 0);
  if (!options.apply || !changes.size)
    return { objects: changes.size, values, applied: false };
  store
    .transaction(() => {
      for (const change of changes.values())
        store
          .query('INSERT OR IGNORE INTO objects VALUES (?,?)')
          .run(change.hash, change.content);
      const affected = new Set<string>();
      for (const record of store
        .query('SELECT id,session_id,payload FROM records')
        .all() as { id: string; session_id: string; payload: string }[]) {
        const payload = JSON.parse(record.payload);
        let changed = false;
        let count = 0;
        for (const key of ['textRef', 'diffRef', 'conversationRef']) {
          const change = changes.get(payload[key]);
          if (change) {
            payload[key] = change.hash;
            count += change.hits;
            changed = true;
          }
        }
        if (changed) {
          store
            .query('UPDATE records SET payload=?,redacted=redacted+? WHERE id=?')
            .run(canonical(payload), count, record.id);
          affected.add(record.session_id);
        }
      }
      for (const sessionId of affected) {
        let prev: string | null = null;
        for (const r of store
          .query('SELECT * FROM records WHERE session_id=? ORDER BY seq')
          .all(sessionId)) {
          const hash = digest(
            canonical({
              id: r.id,
              sessionId: r.session_id,
              sequence: r.seq,
              ts: r.ts,
              capturedAt: r.captured_at,
              kind: r.kind,
              turnId: r.turn_id,
              sourceId: r.source_id,
              payload: JSON.parse(r.payload),
              prev,
              supersedesId: r.supersedes_id,
              redacted: r.redacted,
            }),
          );
          store
            .query('UPDATE records SET prev=?,hash=? WHERE id=?')
            .run(prev, hash, r.id);
          prev = hash;
        }
        store.append(sessionId, {
          kind: 'audit',
          text: `Declared redaction: ${changes.size} content objects transformed; ${values} values withheld.`,
        });
      }
      const destinations = new Set([...changes.values()].map((value) => value.hash));
      for (const old of changes.keys())
        if (!destinations.has(old))
          store.query('DELETE FROM objects WHERE hash=?').run(old);
    })
    .immediate();
  return { objects: changes.size, values, applied: true };
}
