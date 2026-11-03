// Read-only observer used by the real Electron extension-host test. No sync or CLI imports.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.env.SHOWTAIL_HOME!, 'history.sqlite');
if (!existsSync(file)) {
  console.log(JSON.stringify({ records: [], health: null }));
} else {
  const db = new Database(file, { readonly: true });
  try {
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
    console.log(
      JSON.stringify({ records, health: health ? JSON.parse(health.value) : null }),
    );
  } finally {
    db.close();
  }
}
