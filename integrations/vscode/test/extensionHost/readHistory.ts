// Read-only observer used by the real Electron extension-host test. No sync or CLI imports.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = { records: [], health: null };

function read(file: string): unknown {
  if (!existsSync(file)) return EMPTY;
  const db = new Database(file, { readonly: true });
  try {
    // The extension's capture writes this database while the test polls it.
    // Without a busy timeout a read that lands mid-write throws "database is
    // locked" at once and fails the whole run; wait for the writer instead.
    db.exec('PRAGMA busy_timeout = 5000;');
    // The file can exist before the writer has created its tables. Until the
    // schema is there, report an empty history, as for a missing file, so the
    // caller's poll loop simply tries again.
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('records','sessions','objects','meta')",
      )
      .all();
    if (tables.length < 4) return EMPTY;
    const records = db
      .query(
        `
      SELECT r.id, r.kind, r.source_id AS sourceId, r.payload,
        s.native_id AS nativeSessionId, s.transcript_path AS transcriptPath,
        s.tool, o.content AS text
      FROM records r JOIN sessions s ON s.id=r.session_id
      LEFT JOIN objects o ON o.hash=json_extract(r.payload, '$.textRef')
      WHERE NOT EXISTS (SELECT 1 FROM records newer WHERE newer.supersedes_id=r.id)
      ORDER BY r.rowid
    `,
      )
      .all()
      .map((row: any) => ({ ...row, payload: JSON.parse(row.payload) }));
    const health = db
      .query("SELECT value FROM meta WHERE key='capture-health:github-copilot'")
      .get() as { value: string } | null;
    return { records, health: health ? JSON.parse(health.value) : null };
  } finally {
    db.close();
  }
}

console.log(JSON.stringify(read(join(process.env.SHOWTAIL_HOME!, 'history.sqlite'))));
