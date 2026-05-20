/**
 * api/migrate-to-v81-4.js
 * V81.4 — Agent uploads on lease documents.
 *
 * Adds two columns to application_evidence so we can:
 *   1. Distinguish files uploaded by the applicant from files uploaded by an
 *      agent (so the agent UI never lets an agent delete the applicant's
 *      source-of-record submission).
 *   2. Audit which agent uploaded each agent-side file.
 *
 *   - uploaded_by_role  TEXT NOT NULL DEFAULT 'applicant'   ('applicant' | 'agent')
 *   - uploaded_by       INTEGER REFERENCES contacts(id)     (agent contact id, null for applicant)
 *
 * Existing rows backfill to 'applicant' (correct — they were all applicant uploads
 * via the step2-upload endpoint).
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

const MIGRATION_ID = 'v81_4_agent_lease_doc_uploads';

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
async function columnExists(table, col) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${col}`;
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
        uploaded_by_role_col_exists: await columnExists('application_evidence', 'uploaded_by_role'),
        uploaded_by_col_exists:      await columnExists('application_evidence', 'uploaded_by'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // Add columns. DEFAULT 'applicant' ensures existing rows backfill correctly —
      // every pre-V81.4 row was uploaded via the public applicant step2-upload endpoint.
      await sql`
        ALTER TABLE application_evidence
        ADD COLUMN IF NOT EXISTS uploaded_by_role TEXT NOT NULL DEFAULT 'applicant'`;
      await sql`
        ALTER TABLE application_evidence
        ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES contacts(id) ON DELETE SET NULL`;

      // Index on uploaded_by_role isn't worth the overhead — query patterns either
      // hit a specific evidence row by id (PK) or a specific application+category
      // (already indexed). Role is then filtered in-memory or by the agent UI.

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v81-4] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
