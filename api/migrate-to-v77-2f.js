/**
 * api/migrate-to-v77-2f.js
 * V77.2f — Add `default_for` column to the `roles` table.
 *
 * Lets a role be flagged as the default for a specific code-flow purpose,
 * e.g. 'enquiry_creation' (auto-set on new Enquiry deals) or 'listing_agent'
 * (auto-set on new Listing deals). At most one role per purpose; this is
 * enforced at write time, not at the DB level (a partial unique index would
 * also work but the API enforcement is simpler and we keep all writes
 * through one path).
 *
 * Seed:
 *   role 'enquirer'      → default_for = 'enquiry_creation'
 *   role 'listing_agent' → default_for = 'listing_agent'
 *
 * Idempotent (additive ALTER + UPDATE WHERE NULL).
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2f_role_default_for';

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
        default_for_col_exists: await columnExists('roles', 'default_for'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // 1) Add column
      await sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS default_for TEXT`;

      // 2) Seed defaults — only set if the role exists AND no other role
      // currently holds that default_for value (idempotent + safe).
      const enquirerRow = await sql`SELECT id FROM roles WHERE id = 'enquirer' LIMIT 1`;
      if (enquirerRow.length) {
        const occupied = await sql`SELECT id FROM roles WHERE default_for = 'enquiry_creation' LIMIT 1`;
        if (!occupied.length) {
          await sql`UPDATE roles SET default_for = 'enquiry_creation' WHERE id = 'enquirer'`;
        }
      }
      const listingAgentRow = await sql`SELECT id FROM roles WHERE id = 'listing_agent' LIMIT 1`;
      if (listingAgentRow.length) {
        const occupied = await sql`SELECT id FROM roles WHERE default_for = 'listing_agent' LIMIT 1`;
        if (!occupied.length) {
          await sql`UPDATE roles SET default_for = 'listing_agent' WHERE id = 'listing_agent'`;
        }
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-2f] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
