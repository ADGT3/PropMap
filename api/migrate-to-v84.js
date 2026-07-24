/**
 * api/migrate-to-v84.js
 * V84 — Job Title on contacts.
 *
 * Adds a single nullable column so a contact can carry their job title
 * (e.g. "Sales Manager"), shown in the Edit Contact form and the contact
 * card modal, and included in CRM free-text search.
 *
 *   - job_title  TEXT   (nullable; existing rows stay NULL)
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

const MIGRATION_ID = 'v84_contacts_job_title';

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
        job_title_col_exists: await columnExists('contacts', 'job_title'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS job_title TEXT`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v84] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
