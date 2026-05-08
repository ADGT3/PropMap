/**
 * api/migrate-to-v77-2c.js
 * V77.2c — Add retention_consent_at + lease_end_estimate columns to applications.
 *
 * retention_consent_at:  set when applicant ticks the retention consent box on Step 2
 * lease_end_estimate:    set on offer accept = preferred_start_date + lease_term_months
 *                        (used in V78 to schedule auto-purge)
 *
 * Idempotent (additive ALTER COLUMN IF NOT EXISTS).
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2c_retention_lease_dates';

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
        retention_col_exists:    await columnExists('applications', 'retention_consent_at'),
        lease_end_col_exists:    await columnExists('applications', 'lease_end_estimate'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS retention_consent_at TIMESTAMPTZ`;
      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS lease_end_estimate   DATE`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-2c] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
