/**
 * api/migrate-to-v78b.js
 * V78b — Add agent-amendment audit columns to applications.
 *
 * Two new columns:
 *   amended_at         TIMESTAMPTZ  — stamped when an agent edits Offer Terms
 *                                     (rent, bond_weeks, lease_term_months,
 *                                     preferred_start_date, terms) on a
 *                                     submitted application without it being
 *                                     a status transition. Mirror of the
 *                                     applicant's submitted_at — answers
 *                                     "when were the terms last touched".
 *   amended_by_user_id INT          — contact_id of the agent who made the
 *                                     change. NULL means "applicant" (i.e.
 *                                     the values came from the public form).
 *
 * Idempotent (additive). No backfill — historical rows leave both NULL,
 * meaning "no agent amendment has happened" which is correct.
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v78b_offer_terms_amendment_stamps';

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
        amended_at_col_exists:         await columnExists('applications', 'amended_at'),
        amended_by_user_id_col_exists: await columnExists('applications', 'amended_by_user_id'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS amended_at         TIMESTAMPTZ`;
      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS amended_by_user_id INT`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v78b] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
