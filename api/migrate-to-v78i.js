/**
 * api/migrate-to-v78i.js
 * V78i — DD risk attachments table.
 *
 * Adds a new table `dd_attachments` storing files uploaded against each Due
 * Diligence risk row on a deal. Mirrors the schema shape of
 * application_evidence (v77.2b) but scoped to deals + DD keys.
 *
 * Storage: Vercel Blob (private access), URL stored in `url` column. Files
 * are streamed back via /api/dd-attachments?id=N&action=download which
 * requires an agent session.
 *
 * CASCADE on deal delete — confirmed with user that attachments go with the
 * parent deal.
 *
 * GET  → status / dry-run summary
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v78i_dd_attachments_table';

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )`;
}

async function hasMigrationRun() {
  const r = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return r.length > 0;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET') {
      await ensureMigrationsTable();
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran: await hasMigrationRun(),
        note: 'POST to execute — creates dd_attachments table.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();

      await sql`
        CREATE TABLE IF NOT EXISTS dd_attachments (
          id           BIGSERIAL   PRIMARY KEY,
          deal_id      TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          dd_key       TEXT        NOT NULL,
          filename     TEXT        NOT NULL,
          mime_type    TEXT,
          size_bytes   INTEGER,
          url          TEXT        NOT NULL,
          uploaded_by  INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
          uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS dd_attachments_deal_idx ON dd_attachments (deal_id)`;
      await sql`CREATE INDEX IF NOT EXISTS dd_attachments_key_idx  ON dd_attachments (deal_id, dd_key)`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v78i] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
