/**
 * api/migrate-to-v75-7.js
 *
 * V75.7 — Actions
 *
 *   Adds a new first-class "action" entity (task/to-do) that can be:
 *     - Assigned to any Contact (default = current user on creation)
 *     - Linked to a Deal (optional) or standalone
 *     - Tracked through a fixed workflow (todo → wip → due → done | void)
 *     - Displayed on a per-user Kanban wall ("My Actions")
 *
 *   Changes:
 *     1. ALTER boards.board_type TEXT DEFAULT 'deal' NOT NULL
 *        Distinguishes deal boards from action boards.
 *        Existing rows get board_type='deal' automatically (default).
 *
 *     2. CREATE TABLE actions
 *        id, description, assignee_id, creator_id, deal_id,
 *        effort_value, effort_unit, duration_value, duration_unit,
 *        due_date, reminder_date, status, board_id, column_id,
 *        column_order, created_at, updated_at
 *
 *        status ∈ ('todo','wip','due','done','void')
 *        unit   ∈ ('d','m','y')
 *
 *     3. Seed an "Actions" board template (not per-user — each user gets
 *        their own on first visit to the Actions tab, via the /api/actions
 *        endpoint's bootstrap check). Columns seeded per-user on creation:
 *        ToDo, WIP, Due, Done, Void.
 *
 *   Safe to re-run. All statements use IF NOT EXISTS / CHECK skipping.
 *
 *   GET  → status report
 *   POST → runs migration
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';
import { requireSession, requireAdmin } from '../lib/auth.js';

const sql = neon(getDatabaseUrl());

async function columnExists(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${column}
    LIMIT 1`;
  return rows.length > 0;
}

async function tableExists(name) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${name}
    LIMIT 1`;
  return rows.length > 0;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const status = {
      boards_board_type_present: await columnExists('boards', 'board_type'),
      actions_table_present:     await tableExists('actions'),
    };

    if (req.method === 'GET') {
      return res.status(200).json({
        version: 'V75.7',
        ready_to_run: !status.boards_board_type_present || !status.actions_table_present,
        status,
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const steps = [];
    const run = async (label, fn) => {
      try { await fn(); steps.push({ ok: true, step: label }); }
      catch (err) { steps.push({ ok: false, step: label, error: err.message }); }
    };

    // 1. boards.board_type
    await run('ALTER boards: add board_type', () => sql`
      ALTER TABLE boards ADD COLUMN IF NOT EXISTS board_type TEXT NOT NULL DEFAULT 'deal'`);

    await run('CHECK CONSTRAINT boards.board_type', async () => {
      // Postgres 9.6+: add check constraint only if not already present
      const existing = await sql`
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'boards_board_type_check' LIMIT 1`;
      if (!existing.length) {
        await sql`ALTER TABLE boards
          ADD CONSTRAINT boards_board_type_check CHECK (board_type IN ('deal','action'))`;
      }
    });

    // 2. actions table
    await run('CREATE TABLE actions', () => sql`
      CREATE TABLE IF NOT EXISTS actions (
        id              SERIAL      PRIMARY KEY,
        description     TEXT        NOT NULL,
        assignee_id     INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        creator_id      INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        deal_id         TEXT        REFERENCES deals(id) ON DELETE SET NULL,
        effort_days     INTEGER,
        duration_days   INTEGER,
        due_date        DATE,
        reminder_date   DATE,
        status          TEXT        NOT NULL DEFAULT 'todo'
                        CHECK (status IN ('todo','wip','due','done','void')),
        board_id        TEXT        REFERENCES boards(id) ON DELETE SET NULL,
        column_id       TEXT        REFERENCES board_columns(id) ON DELETE SET NULL,
        column_order    INTEGER     NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // V76.2.1: if the actions table already exists from an earlier run with the
    // effort_value/unit + duration_value/unit schema, migrate to effort_days /
    // duration_days. Safe to re-run.
    await run('ALTER actions: add effort_days', () => sql`
      ALTER TABLE actions ADD COLUMN IF NOT EXISTS effort_days INTEGER`);
    await run('ALTER actions: add duration_days', () => sql`
      ALTER TABLE actions ADD COLUMN IF NOT EXISTS duration_days INTEGER`);
    await run('ALTER actions: drop effort_value', () => sql`
      ALTER TABLE actions DROP COLUMN IF EXISTS effort_value`);
    await run('ALTER actions: drop effort_unit', () => sql`
      ALTER TABLE actions DROP COLUMN IF EXISTS effort_unit`);
    await run('ALTER actions: drop duration_value', () => sql`
      ALTER TABLE actions DROP COLUMN IF EXISTS duration_value`);
    await run('ALTER actions: drop duration_unit', () => sql`
      ALTER TABLE actions DROP COLUMN IF EXISTS duration_unit`);

    await run('INDEX actions_assignee_idx', () => sql`
      CREATE INDEX IF NOT EXISTS actions_assignee_idx ON actions (assignee_id)`);

    await run('INDEX actions_deal_idx', () => sql`
      CREATE INDEX IF NOT EXISTS actions_deal_idx ON actions (deal_id)`);

    await run('INDEX actions_board_idx', () => sql`
      CREATE INDEX IF NOT EXISTS actions_board_idx ON actions (board_id)`);

    await run('INDEX actions_column_idx', () => sql`
      CREATE INDEX IF NOT EXISTS actions_column_idx ON actions (column_id, column_order)`);

    await run('INDEX actions_due_date_idx', () => sql`
      CREATE INDEX IF NOT EXISTS actions_due_date_idx ON actions (due_date) WHERE status IN ('todo','wip')`);

    const finalStatus = {
      boards_board_type_present: await columnExists('boards', 'board_type'),
      actions_table_present:     await tableExists('actions'),
    };
    const allOk = steps.every(s => s.ok);
    return res.status(allOk ? 200 : 207).json({
      version:  'V75.7',
      allOk,
      steps,
      final_status: finalStatus,
    });
  } catch (err) {
    console.error('[migrate-v75-7]', err);
    return res.status(500).json({ error: err.message });
  }
}
