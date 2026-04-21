/**
 * api/migrate-to-v75-6.js
 * V75.6 migration — Boards as first-class workflows.
 *
 * Transforms the hard-coded `workflow` enum on deals into a flexible Boards
 * system where each board has user-defined columns, per-column map visibility,
 * and per-user card ordering.
 *
 *   A) CREATE TABLES
 *      - `boards`          (id, name, owner_id, is_system, sort_order)
 *      - `board_columns`   (id, board_id, name, sort_order, show_on_map,
 *                            is_terminal, color)
 *      - `deal_user_order` (user_id, deal_id, column_order)
 *
 *   B) SEED SYSTEM BOARDS
 *      Three system boards with the current stage set:
 *        - "Acquisition"    → shortlisted, under-dd, offer, acquired,
 *                             not-suitable, lost
 *        - "Buyer Enquiry"  → same structure
 *        - "Agency Sales"   → same structure
 *      Column ids use `{board_id}_{stage-slug}` to make migration deterministic.
 *
 *   C) ADD FKs ON DEALS
 *      ALTER TABLE deals ADD COLUMN board_id TEXT REFERENCES boards(id);
 *      ALTER TABLE deals ADD COLUMN column_id TEXT REFERENCES board_columns(id);
 *
 *   D) BACKFILL
 *      UPDATE deals SET board_id = 'sys_{workflow}', column_id = '{board_id}_{stage}'
 *      Every existing deal gets relinked to its corresponding system board + column.
 *
 * The old `workflow` + `stage` columns are KEPT (not dropped) for safety and
 * to allow rollback. Frontend reads board_id/column_id going forward but the
 * old columns remain authoritative as a fallback until a future migration
 * explicitly drops them.
 *
 * Idempotency: tracked via _migrations table.
 *
 * GET  → dry-run status
 * POST → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_6_boards';

// Default column set (current STAGES in kanban.js)
const DEFAULT_COLUMNS = [
  { stage: 'shortlisted',   label: 'Shortlisted',   color: '#f39c12', show_on_map: true,  is_terminal: false },
  { stage: 'under-dd',      label: 'Under DD',      color: '#8e44ad', show_on_map: true,  is_terminal: false },
  { stage: 'offer',         label: 'Offer',         color: '#2980b9', show_on_map: true,  is_terminal: false },
  { stage: 'acquired',      label: 'Acquired',      color: '#27ae60', show_on_map: true,  is_terminal: false },
  { stage: 'not-suitable',  label: 'Not Suitable',  color: '#95a5a6', show_on_map: false, is_terminal: true  },
  { stage: 'lost',          label: 'Lost',          color: '#c0392b', show_on_map: false, is_terminal: true  },
];

const SYSTEM_BOARDS = [
  { id: 'sys_acquisition',   name: 'Acquisition',   workflow: 'acquisition',   sort_order: 0 },
  { id: 'sys_buyer_enquiry', name: 'Buyer Enquiry', workflow: 'buyer_enquiry', sort_order: 1 },
  { id: 'sys_agency_sales',  name: 'Agency Sales',  workflow: 'agency_sales',  sort_order: 2 },
];

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET')  return await dryRun(req, res);
    if (req.method === 'POST') return await execute(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v75.6] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function hasMigrationRun() {
  const existing = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='_migrations'`;
  if (!existing.length) return false;
  const m = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return m.length > 0;
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

async function dryRun(req, res) {
  const alreadyRan   = await hasMigrationRun();
  const boards_exists        = await tableExists('boards');
  const columns_exists       = await tableExists('board_columns');
  const order_exists         = await tableExists('deal_user_order');
  const deals_has_board_id   = await columnExists('deals', 'board_id');
  const deals_has_column_id  = await columnExists('deals', 'column_id');

  // Distribution of existing deals by workflow/stage (what will be backfilled)
  let distribution = [];
  try {
    distribution = await sql`
      SELECT workflow, stage, COUNT(*)::int AS n
      FROM deals
      GROUP BY workflow, stage
      ORDER BY workflow, stage`;
  } catch (_) {}

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    schema: {
      boards_table_exists:        boards_exists,
      board_columns_table_exists: columns_exists,
      deal_user_order_table_exists: order_exists,
      deals_has_board_id:         deals_has_board_id,
      deals_has_column_id:        deals_has_column_id,
    },
    system_boards_to_seed: SYSTEM_BOARDS,
    default_columns_per_board: DEFAULT_COLUMNS,
    deal_distribution_to_backfill: distribution,
  });
}

async function execute(req, res) {
  if (await hasMigrationRun()) {
    return res.status(200).json({ ok: true, already_run: true });
  }

  const steps = [];

  // 1. Ensure _migrations exists
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )`;
  steps.push({ ok: true, step: 'ensure_migrations_table' });

  // 2. Create boards
  await sql`
    CREATE TABLE IF NOT EXISTS boards (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    INTEGER,
      is_system   BOOLEAN DEFAULT FALSE,
      sort_order  INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )`;
  steps.push({ ok: true, step: 'create_boards' });

  // 3. Create board_columns
  await sql`
    CREATE TABLE IF NOT EXISTS board_columns (
      id           TEXT PRIMARY KEY,
      board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      stage_slug   TEXT,  -- for compatibility with legacy stage codes
      sort_order   INTEGER NOT NULL,
      show_on_map  BOOLEAN DEFAULT TRUE,
      is_terminal  BOOLEAN DEFAULT FALSE,
      color        TEXT,
      created_at   TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS board_columns_board_idx ON board_columns(board_id, sort_order)`;
  steps.push({ ok: true, step: 'create_board_columns' });

  // 4. Create deal_user_order
  await sql`
    CREATE TABLE IF NOT EXISTS deal_user_order (
      user_id      INTEGER NOT NULL,
      deal_id      TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      column_order INTEGER NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, deal_id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS deal_user_order_user_idx ON deal_user_order(user_id)`;
  steps.push({ ok: true, step: 'create_deal_user_order' });

  // 5. Add deals.board_id + deals.column_id
  if (!(await columnExists('deals', 'board_id'))) {
    await sql`ALTER TABLE deals ADD COLUMN board_id TEXT REFERENCES boards(id) ON DELETE SET NULL`;
  }
  if (!(await columnExists('deals', 'column_id'))) {
    await sql`ALTER TABLE deals ADD COLUMN column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL`;
  }
  await sql`CREATE INDEX IF NOT EXISTS deals_board_id_idx ON deals(board_id)`;
  await sql`CREATE INDEX IF NOT EXISTS deals_column_id_idx ON deals(column_id)`;
  steps.push({ ok: true, step: 'add_deal_fks' });

  // 6. Seed system boards + columns
  const seededBoards = [];
  for (const b of SYSTEM_BOARDS) {
    await sql`
      INSERT INTO boards (id, name, owner_id, is_system, sort_order)
      VALUES (${b.id}, ${b.name}, NULL, TRUE, ${b.sort_order})
      ON CONFLICT (id) DO NOTHING`;
    seededBoards.push(b.id);

    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      const col = DEFAULT_COLUMNS[i];
      const colId = `${b.id}_${col.stage}`;
      await sql`
        INSERT INTO board_columns (id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color)
        VALUES (${colId}, ${b.id}, ${col.label}, ${col.stage}, ${i},
                ${col.show_on_map}, ${col.is_terminal}, ${col.color})
        ON CONFLICT (id) DO NOTHING`;
    }
  }
  steps.push({ ok: true, step: 'seed_system_boards', boards_seeded: seededBoards.length });

  // 7. Backfill deals.board_id + deals.column_id from legacy workflow+stage
  const updates = await sql`
    UPDATE deals AS d
    SET board_id  = CASE d.workflow
                      WHEN 'acquisition'   THEN 'sys_acquisition'
                      WHEN 'buyer_enquiry' THEN 'sys_buyer_enquiry'
                      WHEN 'agency_sales'  THEN 'sys_agency_sales'
                      ELSE NULL
                    END,
        column_id = CASE d.workflow
                      WHEN 'acquisition'   THEN 'sys_acquisition_'   || d.stage
                      WHEN 'buyer_enquiry' THEN 'sys_buyer_enquiry_' || d.stage
                      WHEN 'agency_sales'  THEN 'sys_agency_sales_'  || d.stage
                      ELSE NULL
                    END
    WHERE d.board_id IS NULL
    RETURNING d.id`;
  steps.push({ ok: true, step: 'backfill_deals', updated: updates.length });

  // 8. Mark migration complete
  await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
  steps.push({ ok: true, step: 'mark_migrations' });

  return res.status(200).json({
    ok: true,
    already_run: false,
    summary: {
      boards_seeded:   SYSTEM_BOARDS.length,
      columns_seeded:  SYSTEM_BOARDS.length * DEFAULT_COLUMNS.length,
      deals_relinked:  updates.length,
    },
    steps,
  });
}
