/**
 * api/migrate-to-v77.js
 * V77 migration — Sales/Lease pipeline foundations.
 *
 * Phase 1 of the V77 build. Sets up the four-board structure for property
 * sales and leasing workflows. CRM-side only — no public forms or deal-modal
 * sections in this phase. Boards render generically via the existing kanban,
 * so this migration is the entire Phase 1 deliverable.
 *
 *   A) RENAME existing system boards
 *      - sys_buyer_enquiry  →  sys_sales_enquiry   ("Sales Enquiry")
 *      - sys_agency_sales   →  sys_sales_listings  ("Sales Listings")
 *
 *      Implemented as drop-and-recreate (both target boards have zero deals
 *      in production, verified before authoring this migration). The
 *      board_columns FK uses ON DELETE CASCADE so dropping the board cleans
 *      its columns automatically. The deals.board_id FK uses ON DELETE SET
 *      NULL — but no deals reference these boards, so nothing's affected.
 *
 *   B) REPLACE columns on Sales Enquiry
 *      Old columns (renamed-but-stale flags from V75.6 + admin UI edits) are
 *      dropped via the cascade. New columns: Enquiry, Inspected, Offer,
 *      Accepted, Contract, Exchanged, Sold, Withdrawn / Lost.
 *
 *   C) FIX columns on Sales Listings
 *      The labels (Prospecting, Appraisal, ..., Withdrawn) are kept but the
 *      stage_slugs and is_terminal/show_on_map flags are corrected. The
 *      live prod state had Active Listing / Under Offer / Exchanged flagged
 *      is_terminal=true (a bug from how the V75.6 default seed interacted
 *      with admin UI renames — slugs and flags didn't move with labels).
 *      Only Settled and Withdrawn should be terminal.
 *
 *   D) CREATE two new boards
 *      - sys_lease_listings  ("Lease Listings")
 *      - sys_lease_enquiry   ("Lease Enquiry")
 *
 *   E) SEED new roles
 *      Landlord, Tenant, Applicant, Co-Applicant, Enquirer, Referee,
 *      Leasing Manager. All on the deal scope (Landlord also on property).
 *
 * Idempotency: tracked via _migrations table. Safe to re-run.
 *
 * GET  → dry-run / status
 * POST → execute (admin-only)
 *
 * No DB schema change. No new tables. No changes to deals, properties,
 * parcels, contacts, notes, or anything else outside boards/columns/roles.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_sales_lease_boards';

// ── Board definitions ───────────────────────────────────────────────────────
//
// Each board: { id, name, sort_order, columns[] }.
// Each column: { stage, label, color, show_on_map, is_terminal }.
// Column id is auto-generated as `${board_id}_${stage}`.

const SALES_ENQUIRY = {
  id: 'sys_sales_enquiry',
  name: 'Sales Enquiry',
  sort_order: 1,
  columns: [
    { stage: 'enquiry',         label: 'Enquiry',           color: '#f39c12', show_on_map: true,  is_terminal: false },
    { stage: 'inspected',       label: 'Inspected',         color: '#3498db', show_on_map: true,  is_terminal: false },
    { stage: 'offer',           label: 'Offer',             color: '#2980b9', show_on_map: true,  is_terminal: false },
    { stage: 'accepted',        label: 'Accepted',          color: '#16a085', show_on_map: true,  is_terminal: false },
    { stage: 'contract',        label: 'Contract',          color: '#8e44ad', show_on_map: true,  is_terminal: false },
    { stage: 'exchanged',       label: 'Exchanged',         color: '#9b59b6', show_on_map: true,  is_terminal: false },
    { stage: 'sold',            label: 'Sold',              color: '#27ae60', show_on_map: true,  is_terminal: true  },
    { stage: 'withdrawn-lost',  label: 'Withdrawn / Lost',  color: '#95a5a6', show_on_map: false, is_terminal: true  },
  ],
};

// Sales Listings — keep the labels and the green-ramp colours that the user
// already configured in the admin UI on prod (see V77 spec). Only the slugs
// and the is_terminal/show_on_map flags need correcting.
const SALES_LISTINGS = {
  id: 'sys_sales_listings',
  name: 'Sales Listings',
  sort_order: 2,
  columns: [
    { stage: 'prospecting',    label: 'Prospecting',    color: '#cce8b5', show_on_map: true,  is_terminal: false },
    { stage: 'appraisal',      label: 'Appraisal',      color: '#b1dd8c', show_on_map: true,  is_terminal: false },
    { stage: 'onboarding',     label: 'Onboarding',     color: '#77bb41', show_on_map: true,  is_terminal: false },
    { stage: 'active-listing', label: 'Active Listing', color: '#669c35', show_on_map: true,  is_terminal: false },
    { stage: 'under-offer',    label: 'Under Offer',    color: '#4f7a28', show_on_map: true,  is_terminal: false },
    { stage: 'exchanged',      label: 'Exchanged',      color: '#38571a', show_on_map: true,  is_terminal: false },
    { stage: 'settled',        label: 'Settled',        color: '#263e0f', show_on_map: true,  is_terminal: true  },
    { stage: 'withdrawn',      label: 'Withdrawn',      color: '#000000', show_on_map: false, is_terminal: true  },
  ],
};

// Lease Listings — mirror of Sales Listings with two stage swaps:
// Exchanged → Validating, Settled → Leased. Same green progression.
const LEASE_LISTINGS = {
  id: 'sys_lease_listings',
  name: 'Lease Listings',
  sort_order: 3,
  columns: [
    { stage: 'prospecting',    label: 'Prospecting',    color: '#cce8b5', show_on_map: true,  is_terminal: false },
    { stage: 'appraisal',      label: 'Appraisal',      color: '#b1dd8c', show_on_map: true,  is_terminal: false },
    { stage: 'onboarding',     label: 'Onboarding',     color: '#77bb41', show_on_map: true,  is_terminal: false },
    { stage: 'active-listing', label: 'Active Listing', color: '#669c35', show_on_map: true,  is_terminal: false },
    { stage: 'under-offer',    label: 'Under Offer',    color: '#4f7a28', show_on_map: true,  is_terminal: false },
    { stage: 'validating',     label: 'Validating',     color: '#e67e22', show_on_map: true,  is_terminal: false },
    { stage: 'leased',         label: 'Leased',         color: '#263e0f', show_on_map: true,  is_terminal: true  },
    { stage: 'withdrawn',      label: 'Withdrawn',      color: '#000000', show_on_map: false, is_terminal: true  },
  ],
};

const LEASE_ENQUIRY = {
  id: 'sys_lease_enquiry',
  name: 'Lease Enquiry',
  sort_order: 4,
  columns: [
    { stage: 'enquiry',             label: 'Enquiry',               color: '#f39c12', show_on_map: true,  is_terminal: false },
    { stage: 'inspected',           label: 'Inspected',             color: '#3498db', show_on_map: true,  is_terminal: false },
    { stage: 'offer',               label: 'Offer',                 color: '#2980b9', show_on_map: true,  is_terminal: false },
    { stage: 'contract',            label: 'Contract',              color: '#8e44ad', show_on_map: true,  is_terminal: false },
    { stage: 'validated',           label: 'Validated',             color: '#16a085', show_on_map: true,  is_terminal: false },
    { stage: 'leased',              label: 'Leased',                color: '#27ae60', show_on_map: true,  is_terminal: true  },
    { stage: 'withdrawn-declined',  label: 'Withdrawn / Declined',  color: '#95a5a6', show_on_map: false, is_terminal: true  },
  ],
};

const NEW_BOARDS_TO_CREATE = [SALES_ENQUIRY, SALES_LISTINGS, LEASE_LISTINGS, LEASE_ENQUIRY];

// ── Old board IDs being replaced (drop-and-recreate) ────────────────────────
//
// We delete sys_buyer_enquiry and sys_agency_sales to make way for their
// renamed counterparts. Both verified empty in prod (zero deals reference
// them). The board_columns FK ON DELETE CASCADE handles their columns.
const OLD_BOARDS_TO_REMOVE = ['sys_buyer_enquiry', 'sys_agency_sales'];

// ── New roles ───────────────────────────────────────────────────────────────
//
// Sort orders chosen to slot in alongside existing roles from V75:
//   vendor=10, owner=20, property_manager=30, agent=40, buyers_agent=50,
//   purchaser=60, referrer=70, solicitor=80
const NEW_ROLES = [
  { id: 'landlord',        label: 'Landlord',         scopes: ['property','deal'], default_scope: 'property', sort_order: 25 },
  { id: 'lease_manager',   label: 'Leasing Manager',  scopes: ['property','deal'], default_scope: 'property', sort_order: 35 },
  { id: 'tenant',          label: 'Tenant',           scopes: ['deal'],            default_scope: 'deal',     sort_order: 65 },
  { id: 'applicant',       label: 'Applicant',        scopes: ['deal'],            default_scope: 'deal',     sort_order: 66 },
  { id: 'co_applicant',    label: 'Co-Applicant',     scopes: ['deal'],            default_scope: 'deal',     sort_order: 67 },
  { id: 'enquirer',        label: 'Enquirer',         scopes: ['deal'],            default_scope: 'deal',     sort_order: 68 },
  { id: 'referee',         label: 'Referee',          scopes: ['deal'],            default_scope: 'deal',     sort_order: 90 },
];

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET')  return await dryRun(req, res);
    if (req.method === 'POST') return await execute(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function tableExists(name) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${name}`;
  return r.length > 0;
}

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )`;
}

async function hasMigrationRun() {
  if (!(await tableExists('_migrations'))) return false;
  const m = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return m.length > 0;
}

async function dealsOnBoard(boardId) {
  if (!(await tableExists('deals'))) return 0;
  const r = await sql`SELECT COUNT(*)::int AS n FROM deals WHERE board_id = ${boardId}`;
  return r[0]?.n ?? 0;
}

// ── Dry-run / status ────────────────────────────────────────────────────────

async function dryRun(req, res) {
  await ensureMigrationsTable();
  const alreadyRan = await hasMigrationRun();

  // Inspect current prod state for the boards we touch
  const currentBoards = [];
  if (await tableExists('boards')) {
    const allIds = [...OLD_BOARDS_TO_REMOVE, ...NEW_BOARDS_TO_CREATE.map(b => b.id)];
    for (const id of allIds) {
      const rows = await sql`SELECT id, name, is_system FROM boards WHERE id = ${id}`;
      const exists = rows.length > 0;
      const dealCount = exists ? await dealsOnBoard(id) : 0;
      let columnCount = 0;
      if (exists && (await tableExists('board_columns'))) {
        const c = await sql`SELECT COUNT(*)::int AS n FROM board_columns WHERE board_id = ${id}`;
        columnCount = c[0]?.n ?? 0;
      }
      currentBoards.push({
        id,
        exists,
        name: rows[0]?.name ?? null,
        deal_count: dealCount,
        column_count: columnCount,
        action: planAction(id, exists, dealCount),
      });
    }
  }

  // Inspect existing roles
  let existingRoleIds = [];
  if (await tableExists('roles')) {
    const r = await sql`SELECT id FROM roles WHERE id = ANY(${NEW_ROLES.map(r => r.id)})`;
    existingRoleIds = r.map(x => x.id);
  }
  const rolesPlan = NEW_ROLES.map(r => ({
    id: r.id,
    label: r.label,
    action: existingRoleIds.includes(r.id) ? 'skip (already exists)' : 'insert',
  }));

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    boards: currentBoards,
    roles: rolesPlan,
    summary: {
      old_boards_to_drop: OLD_BOARDS_TO_REMOVE.length,
      new_boards_to_create: NEW_BOARDS_TO_CREATE.length,
      new_roles_to_seed: NEW_ROLES.filter(r => !existingRoleIds.includes(r.id)).length,
    },
    notes: alreadyRan
      ? ['Migration already recorded in _migrations — POST will be a no-op.']
      : [
          'POST to execute. The two old boards (sys_buyer_enquiry, sys_agency_sales) are dropped and recreated with new IDs and column sets.',
          'If either old board has any deals on it, the migration aborts with a 409 — manual intervention required (move the deals first).',
          'New roles are inserted with ON CONFLICT DO NOTHING — re-runs are safe.',
        ],
  });
}

function planAction(id, exists, dealCount) {
  if (OLD_BOARDS_TO_REMOVE.includes(id)) {
    if (!exists) return 'skip (already removed)';
    if (dealCount > 0) return `ABORT — has ${dealCount} deal(s); refuse to drop`;
    return 'drop (zero deals)';
  }
  if (NEW_BOARDS_TO_CREATE.some(b => b.id === id)) {
    return exists ? 'skip board insert (already exists), upsert columns' : 'create board + columns';
  }
  return '?';
}

// ── Execute ─────────────────────────────────────────────────────────────────

async function execute(req, res) {
  await ensureMigrationsTable();

  if (await hasMigrationRun()) {
    return res.status(200).json({
      ok: true,
      already_run: true,
      message: 'V77 migration has already been recorded — nothing to do.',
    });
  }

  // Sanity check: required tables must exist (V75.6 must have run)
  for (const t of ['boards', 'board_columns']) {
    if (!(await tableExists(t))) {
      return res.status(500).json({
        error: `Required table missing: ${t}. Run V75.6 migration first.`,
      });
    }
  }

  const steps = [];

  // 1. Refuse to drop any old board that has deals on it. Defensive — prod is
  //    verified empty but we don't want to silently destroy data if somehow
  //    a deal landed there between authoring and execution.
  for (const oldId of OLD_BOARDS_TO_REMOVE) {
    const exists = (await sql`SELECT 1 FROM boards WHERE id = ${oldId}`).length > 0;
    if (!exists) continue;
    const dc = await dealsOnBoard(oldId);
    if (dc > 0) {
      return res.status(409).json({
        error: `Cannot drop board "${oldId}" — has ${dc} deal(s). Move them first.`,
      });
    }
  }
  steps.push({ ok: true, step: 'precheck_old_boards_empty' });

  // 2. Drop the two old boards. board_columns cascades; deals.board_id has
  //    ON DELETE SET NULL but we already verified zero deals reference them.
  let droppedBoards = 0;
  for (const oldId of OLD_BOARDS_TO_REMOVE) {
    const r = await sql`DELETE FROM boards WHERE id = ${oldId} RETURNING id`;
    if (r.length) droppedBoards++;
  }
  steps.push({ ok: true, step: 'drop_old_boards', dropped: droppedBoards });

  // 3. Create / upsert each new board and replace its column set.
  //    For each board:
  //      - INSERT board ON CONFLICT DO UPDATE (so re-runs idempotent)
  //      - DELETE all existing board_columns for this board_id
  //      - INSERT the new column set with deterministic ids
  let boardsCreated = 0;
  let columnsSeeded = 0;
  for (const b of NEW_BOARDS_TO_CREATE) {
    // Defensive: if a new board id somehow already exists with deals on it,
    // refuse to clobber its columns.
    const existingDeals = await dealsOnBoard(b.id);
    if (existingDeals > 0) {
      return res.status(409).json({
        error: `Board "${b.id}" already exists with ${existingDeals} deal(s). Refusing to replace its columns. Manual intervention required.`,
      });
    }

    await sql`
      INSERT INTO boards (id, name, owner_id, is_system, sort_order)
      VALUES (${b.id}, ${b.name}, NULL, TRUE, ${b.sort_order})
      ON CONFLICT (id) DO UPDATE
        SET name       = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            is_system  = TRUE,
            updated_at = now()`;
    boardsCreated++;

    // Wipe existing columns (deterministic — fresh column set per board)
    await sql`DELETE FROM board_columns WHERE board_id = ${b.id}`;

    for (let i = 0; i < b.columns.length; i++) {
      const col = b.columns[i];
      const colId = `${b.id}_${col.stage}`;
      await sql`
        INSERT INTO board_columns (id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color)
        VALUES (${colId}, ${b.id}, ${col.label}, ${col.stage}, ${i},
                ${col.show_on_map}, ${col.is_terminal}, ${col.color})`;
      columnsSeeded++;
    }
  }
  steps.push({
    ok: true,
    step: 'seed_boards_and_columns',
    boards_seeded: boardsCreated,
    columns_seeded: columnsSeeded,
  });

  // 4. Seed new roles (idempotent via ON CONFLICT DO NOTHING).
  let rolesInserted = 0;
  if (await tableExists('roles')) {
    for (const r of NEW_ROLES) {
      const rows = await sql`
        INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system)
        VALUES (${r.id}, ${r.label}, ${r.scopes}, ${r.default_scope}, ${r.sort_order}, true, true)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      if (rows.length) rolesInserted++;
    }
    steps.push({ ok: true, step: 'seed_roles', inserted: rolesInserted });
  } else {
    steps.push({ ok: false, step: 'seed_roles', skipped: 'roles table does not exist' });
  }

  // 5. Mark migration complete
  await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
  steps.push({ ok: true, step: 'mark_migrations' });

  return res.status(200).json({
    ok: true,
    already_run: false,
    summary: {
      boards_dropped:  droppedBoards,
      boards_created:  boardsCreated,
      columns_seeded:  columnsSeeded,
      roles_inserted:  rolesInserted,
    },
    steps,
  });
}
