/**
 * api/migrate-to-v77-1b.js
 * V77.1b — Adds parent_deal_id self-reference on deals table.
 *
 * Why: an Enquiry deal is logically about a Listing, not a Property directly.
 * A property may have multiple sequential listings (sold → re-listed → sold);
 * we need to disambiguate which listing campaign an enquiry belongs to.
 *
 * Schema change:
 *   ALTER TABLE deals
 *     ADD COLUMN parent_deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL;
 *   CREATE INDEX deals_parent_deal_idx ON deals (parent_deal_id);
 *
 * Semantics:
 *   - NULL on most deals (Acquisition, Listings, Billing, user boards)
 *   - For Sales Enquiry deals: points to the Sales Listing deal they're enquiring about
 *   - For Lease Enquiry deals: points to the Lease Listing deal they're enquiring about
 *
 * No data backfill needed — V77 boards haven't shipped to prod, no Enquiry deals exist.
 *
 * GET  → dry-run / status
 * POST → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_1b_parent_deal_id';

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

async function columnExists(table, column) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
  return r.length > 0;
}

async function constraintExists(table, constraint) {
  const r = await sql`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name=${table} AND constraint_name=${constraint}`;
  return r.length > 0;
}

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
    console.error('[migrate-v77-1b] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

async function dryRun(req, res) {
  await ensureMigrationsTable();
  const alreadyRan = await hasMigrationRun();
  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run:  alreadyRan,
    description:  'V77.1b — Add parent_deal_id self-reference on deals table',
    state: {
      column_exists:    await columnExists('deals', 'parent_deal_id'),
      fk_exists:        await constraintExists('deals', 'deals_parent_deal_id_fkey'),
    },
  });
}

async function execute(req, res) {
  await ensureMigrationsTable();

  if (await hasMigrationRun()) {
    return res.status(200).json({
      ok:          true,
      already_run: true,
      message:     'Migration already executed.',
    });
  }

  const steps = [];

  // 1. ADD COLUMN
  try {
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS parent_deal_id TEXT`;
    steps.push({ step: 'ADD COLUMN parent_deal_id', status: 'ok' });
  } catch (err) {
    steps.push({ step: 'ADD COLUMN parent_deal_id', status: 'error', error: err.message });
    throw err;
  }

  // 2. ADD FK constraint (idempotent — IF NOT EXISTS via constraintExists check)
  try {
    if (await constraintExists('deals', 'deals_parent_deal_id_fkey')) {
      steps.push({ step: 'ADD FK deals_parent_deal_id_fkey', status: 'skipped (exists)' });
    } else {
      await sql`
        ALTER TABLE deals
        ADD CONSTRAINT deals_parent_deal_id_fkey
        FOREIGN KEY (parent_deal_id)
        REFERENCES deals(id) ON DELETE SET NULL`;
      steps.push({ step: 'ADD FK deals_parent_deal_id_fkey', status: 'ok' });
    }
  } catch (err) {
    steps.push({ step: 'ADD FK deals_parent_deal_id_fkey', status: 'error', error: err.message });
    throw err;
  }

  // 3. CREATE INDEX
  try {
    await sql`CREATE INDEX IF NOT EXISTS deals_parent_deal_idx ON deals (parent_deal_id)`;
    steps.push({ step: 'CREATE INDEX deals_parent_deal_idx', status: 'ok' });
  } catch (err) {
    steps.push({ step: 'CREATE INDEX deals_parent_deal_idx', status: 'error', error: err.message });
    throw err;
  }

  // Mark complete
  await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;

  return res.status(200).json({
    ok:           true,
    migration_id: MIGRATION_ID,
    steps_run:    steps.length,
    steps,
  });
}
