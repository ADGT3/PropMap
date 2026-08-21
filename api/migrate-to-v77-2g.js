/**
 * api/migrate-to-v77-2g.js
 * V77.2g — Replace `roles.default_for` (text) with `role_boards` (join table).
 *
 * The Roles table previously had a `default_for` text column with one of two
 * values: 'enquiry_creation' or 'listing_agent'. Card creation looked up
 * roles by these symbolic purposes.
 *
 * That model didn't capture reality — a single role can be the default for
 * multiple boards (e.g. `enquirer` is the default for both Sales Enquiry and
 * Lease Enquiry boards), and multiple roles can claim the same board (e.g.
 * for a Listings card the agent might want either `listing_agent` or
 * `vendor` as the auto-assigned contact). So we move to a many-to-many
 * relation against the `boards` table.
 *
 * Migrations:
 *   1. CREATE role_boards (role_id, board_id) with CASCADE FKs
 *   2. Migrate v77.2f data:
 *        - role with default_for='enquiry_creation' → rows for both enquiry boards
 *        - role with default_for='listing_agent'   → rows for both listing boards
 *   3. DROP roles.default_for column
 *
 * Idempotent.
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2g_role_boards';

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
async function tableExists(name) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${name}`;
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
        role_boards_exists: await tableExists('role_boards'),
        default_for_column_exists: await columnExists('roles', 'default_for'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // 1) Create the join table.
      await sql`
        CREATE TABLE IF NOT EXISTS role_boards (
          role_id  TEXT NOT NULL REFERENCES roles(id)  ON DELETE CASCADE,
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          PRIMARY KEY (role_id, board_id)
        )`;

      // 2) Migrate v77.2f data, if the column exists.
      if (await columnExists('roles', 'default_for')) {
        // 'enquiry_creation' → both enquiry boards
        await sql`
          INSERT INTO role_boards (role_id, board_id)
          SELECT r.id, b.id
            FROM roles r
            JOIN boards b ON b.id IN ('sys_sales_enquiry', 'sys_lease_enquiry')
           WHERE r.default_for = 'enquiry_creation'
          ON CONFLICT (role_id, board_id) DO NOTHING`;
        // 'listing_agent' → both listing boards
        await sql`
          INSERT INTO role_boards (role_id, board_id)
          SELECT r.id, b.id
            FROM roles r
            JOIN boards b ON b.id IN ('sys_sales_listings', 'sys_lease_listings')
           WHERE r.default_for = 'listing_agent'
          ON CONFLICT (role_id, board_id) DO NOTHING`;

        // 3) Drop the old column.
        await sql`ALTER TABLE roles DROP COLUMN IF EXISTS default_for`;
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-2g] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
