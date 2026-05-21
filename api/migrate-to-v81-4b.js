/**
 * api/migrate-to-v81-4b.js
 * V81.4b — Audit decoration on file lists (system-wide).
 *
 * V81.4 added uploaded_by + uploaded_by_role columns to application_evidence,
 * but only agent uploads filled uploaded_by. Existing applicant rows had
 * uploaded_by=NULL (the column defaults applied, but the historical rows
 * predate the column).
 *
 * For the audit decoration ("uploaded by <name> (#<id>) on <timestamp>") to
 * work uniformly on applicant rows too, this migration backfills
 *   uploaded_by := applicant_contact_id
 * for every row where role='applicant' AND uploaded_by IS NULL AND
 * applicant_contact_id IS NOT NULL.
 *
 * Edge case: a row might have NULL applicant_contact_id (theoretically
 * possible for a lease-doc slot — though current schema makes that unlikely).
 * Those stay NULL; the frontend shows "Unknown" for the uploader name but
 * still shows the timestamp.
 *
 * Also adds a JOIN-friendly index on uploaded_by.
 *
 * Idempotent. Safe to re-run.
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v81_4b_backfill_uploaded_by';

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
async function rowsNeedingBackfill() {
  const r = await sql`
    SELECT COUNT(*)::int AS n
    FROM application_evidence
    WHERE uploaded_by IS NULL
      AND uploaded_by_role = 'applicant'
      AND applicant_contact_id IS NOT NULL`;
  return r[0]?.n ?? 0;
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
        rows_needing_backfill: await rowsNeedingBackfill(),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // Backfill applicant rows. Targets the *historical* rows that pre-date
      // the V81.4 column add; new applicant uploads (V81.4+) should also be
      // covered if any flowed through before this migration ran.
      const updated = await sql`
        UPDATE application_evidence
        SET uploaded_by = applicant_contact_id
        WHERE uploaded_by IS NULL
          AND uploaded_by_role = 'applicant'
          AND applicant_contact_id IS NOT NULL
        RETURNING id`;

      // Index for the LEFT JOIN onto contacts in api/applications.js evidence SELECT.
      // Without this, large applications would do a sequential scan on every fetch.
      await sql`
        CREATE INDEX IF NOT EXISTS application_evidence_uploaded_by_idx
        ON application_evidence (uploaded_by)`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        rows_backfilled: updated.length,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v81-4b] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
