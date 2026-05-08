/**
 * api/migrate-to-v77-2b.js
 * V77.2b — Add application_evidence table for Step 2 file uploads.
 *
 * Belated addition to V77.2 — main v77-2 migration ran without it, so this
 * is a follow-up. Idempotent: tracked separately in _migrations.
 *
 * GET  → dry-run / status
 * POST → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2b_application_evidence';

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

async function tableExists(table) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${table}`;
  return r.length > 0;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET') {
      await ensureMigrationsTable();
      const ran = await hasMigrationRun();
      const exists = await tableExists('application_evidence');
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran: ran,
        application_evidence_exists: exists,
        note: ran ? 'Migration already ran.' : 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`
        CREATE TABLE IF NOT EXISTS application_evidence (
          id                    BIGSERIAL PRIMARY KEY,
          application_id        BIGINT      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          applicant_contact_id  INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
          category              TEXT        NOT NULL,
          filename              TEXT        NOT NULL,
          mime_type             TEXT,
          size_bytes            INTEGER,
          url                   TEXT        NOT NULL,
          points_value          INTEGER     DEFAULT 0,
          validated_at          TIMESTAMPTZ,
          validated_by          INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
          uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS application_evidence_app_idx       ON application_evidence (application_id)`;
      await sql`CREATE INDEX IF NOT EXISTS application_evidence_applicant_idx ON application_evidence (applicant_contact_id)`;
      await sql`CREATE INDEX IF NOT EXISTS application_evidence_category_idx  ON application_evidence (category)`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-2b] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
