/**
 * api/migrate-to-v77-2d.js
 * V77.2d — Add validation_jsonb column + evidence_resubmit_requested status.
 *
 * validation_jsonb: per-application validation state. Replaces deals.data.validation
 *                   which was per-deal. Each application has its own checklist now.
 *                   Schema (loose JSON):
 *                     {
 *                       id_verified: bool,
 *                       income_evidence_reviewed: bool,
 *                       references_checked: bool,
 *                       rental_history_clean: bool,
 *                       affordability_confirmed: bool,
 *                       condition_report_completed: bool,
 *                       notes: string,
 *                       last_updated_at: iso,
 *                       last_updated_by: number (user id)
 *                     }
 *
 * evidence_resubmit_requested: agent has requested updates from applicant.
 *                              Transitions:
 *                                evidence_submitted → evidence_resubmit_requested
 *                                evidence_resubmit_requested → evidence_submitted
 *                              Step 2 form unlocks for applicant when in this status.
 *
 * Idempotent (additive).
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2d_validation_resubmit';

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
        validation_col_exists: await columnExists('applications', 'validation_jsonb'),
        resubmit_at_col_exists: await columnExists('applications', 'resubmit_requested_at'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // Per-application validation state
      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS validation_jsonb       JSONB`;
      // Timestamp when agent requested resubmit
      await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS resubmit_requested_at  TIMESTAMPTZ`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-2d] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
