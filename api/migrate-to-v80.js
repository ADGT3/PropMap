/**
 * api/migrate-to-v80.js
 * V80 — Multi-assignee Actions + inspection_attendance interaction_type seed.
 *
 * Two changes:
 *   1. Replace `actions.assignee_id` (single contact) with the join table
 *      `action_assignees (action_id, contact_id)` — one Action can now have
 *      N assignees. When any one of them updates the action (status, column,
 *      notes), all see the change because there is only one row.
 *      - CREATE TABLE action_assignees with CASCADE FKs
 *      - Backfill: copy every actions.assignee_id into a row of action_assignees
 *      - DROP COLUMN actions.assignee_id
 *
 *   2. Seed `interaction_types` row `inspection_attendance` so the auto-note
 *      created on every inspection check-in can categorise itself.
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

const MIGRATION_ID = 'v80_multi_assignee_actions';

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
        action_assignees_exists: await tableExists('action_assignees'),
        actions_assignee_id_exists: await columnExists('actions', 'assignee_id'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // 1) Create the join table with per-assignee position columns.
      //    Each (action, contact) pair tracks its own placement on the
      //    assignee's My Actions board — board_id is implicit (the assignee's
      //    own board). column_id + column_order are personalised per assignee
      //    so different assignees can reorder within a column independently.
      //    Status is shared (lives on actions.status) — when any assignee
      //    drags the card to a different column, status changes for everyone,
      //    and every assignee's column_id is updated to the matching column
      //    on their own board.
      await sql`
        CREATE TABLE IF NOT EXISTS action_assignees (
          action_id     INTEGER NOT NULL REFERENCES actions(id)  ON DELETE CASCADE,
          contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          column_id     INTEGER REFERENCES board_columns(id) ON DELETE SET NULL,
          column_order  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (action_id, contact_id)
        )`;

      // 2) Backfill — each existing action's (assignee_id, column_id, column_order)
      //    becomes one row in action_assignees. Only runs if legacy columns exist.
      if (await columnExists('actions', 'assignee_id')) {
        await sql`
          INSERT INTO action_assignees (action_id, contact_id, column_id, column_order)
          SELECT id, assignee_id, column_id, COALESCE(column_order, 0)
            FROM actions
           WHERE assignee_id IS NOT NULL
          ON CONFLICT DO NOTHING`;

        // 3) Drop the legacy single-assignee column + the now-personalised
        //    placement columns from actions. board_id stays on actions only
        //    if multiple legacy callers reference it; we drop it too because
        //    each assignee's board is determined by ensureUserActionsBoard().
        await sql`ALTER TABLE actions DROP COLUMN IF EXISTS assignee_id`;
        await sql`ALTER TABLE actions DROP COLUMN IF EXISTS column_id`;
        await sql`ALTER TABLE actions DROP COLUMN IF EXISTS column_order`;
        await sql`ALTER TABLE actions DROP COLUMN IF EXISTS board_id`;
      }

      // 4) Seed `inspection_attendance` interaction_type if missing.
      const existingType = await sql`
        SELECT 1 FROM interaction_types WHERE id = 'inspection_attendance'`;
      if (!existingType.length) {
        await sql`
          INSERT INTO interaction_types (id, label, direction, sort_order, active, system)
          VALUES ('inspection_attendance', 'Inspection Attendance', 'inbound', 100, true, true)
          ON CONFLICT (id) DO NOTHING`;
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        action_assignees_table:           await tableExists('action_assignees'),
        actions_assignee_id_dropped:      !(await columnExists('actions', 'assignee_id')),
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v80] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
