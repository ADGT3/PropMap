/**
 * api/migrate-to-v77-1c.js
 * V77.1c — Drop contacts.source column + seed 'domain_api' interaction_type.
 *
 * Source is now strictly a per-interaction (per-note) attribute. Holding it
 * also on the contact creates ambiguity (which is authoritative? what if they
 * differ?) and drift (contact source can be edited but earlier notes preserve
 * original). Right model: source lives only on notes.source.
 *
 * Per build plan v0.18 §12 Q3 (locked decision):
 *   - Drop contacts.source column entirely
 *   - Existing values on prod (legacy free-text from V76.x) are NOT backfilled
 *     into synthetic notes — V77 hasn't shipped to prod yet so there's no
 *     production data we need to preserve. Preview data is disposable.
 *
 * Also seeds a new interaction_type:
 *   - id: 'domain_api', label: 'Domain API', direction: 'inbound', system: true
 *   - Used by the CRM > Domain "+ Add" button when creating a new contact from
 *     a Domain listing agent — the auto-note records that this contact's
 *     details came in via the Domain API.
 *
 * Schema change:
 *   ALTER TABLE contacts DROP COLUMN source;
 *   INSERT INTO interaction_types (...) VALUES ('domain_api', ...);
 *
 * GET  → dry-run / status
 * POST → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_1c_drop_contacts_source';

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
    console.error('[migrate-v77-1c] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

async function dryRun(req, res) {
  await ensureMigrationsTable();
  const alreadyRan = await hasMigrationRun();
  // Check whether 'domain_api' interaction_type is already seeded
  let domainApiSeeded = false;
  try {
    const r = await sql`SELECT 1 FROM interaction_types WHERE id = 'domain_api'`;
    domainApiSeeded = r.length > 0;
  } catch (_) { /* table might not exist if v77.1 migration hasn't run */ }
  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run:  alreadyRan,
    description:  "V77.1c — Drop contacts.source column + seed 'domain_api' interaction_type",
    state: {
      column_exists:        await columnExists('contacts', 'source'),
      fk_exists:            await constraintExists('contacts', 'contacts_source_fkey'),
      domain_api_seeded:    domainApiSeeded,
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

  // 1. DROP FK if exists (defensive — it should exist after V77.1 migration)
  try {
    if (await constraintExists('contacts', 'contacts_source_fkey')) {
      await sql`ALTER TABLE contacts DROP CONSTRAINT contacts_source_fkey`;
      steps.push({ step: 'DROP CONSTRAINT contacts_source_fkey', status: 'ok' });
    } else {
      steps.push({ step: 'DROP CONSTRAINT contacts_source_fkey', status: 'skipped (not present)' });
    }
  } catch (err) {
    steps.push({ step: 'DROP CONSTRAINT contacts_source_fkey', status: 'error', error: err.message });
    throw err;
  }

  // 2. DROP COLUMN
  try {
    await sql`ALTER TABLE contacts DROP COLUMN IF EXISTS source`;
    steps.push({ step: 'DROP COLUMN contacts.source', status: 'ok' });
  } catch (err) {
    steps.push({ step: 'DROP COLUMN contacts.source', status: 'error', error: err.message });
    throw err;
  }

  // 3. SEED interaction_types row 'domain_api' (idempotent)
  // Used by the CRM > Domain "+ Add" button to record agent-import events as
  // a contact-level note. Direction = 'inbound' so the Source dropdown is
  // available for these notes.
  try {
    await sql`
      INSERT INTO interaction_types (id, label, direction, sort_order, active, system)
      VALUES ('domain_api', 'Domain API', 'inbound', 50, true, true)
      ON CONFLICT (id) DO NOTHING`;
    steps.push({ step: "SEED interaction_types 'domain_api'", status: 'ok' });
  } catch (err) {
    steps.push({ step: "SEED interaction_types 'domain_api'", status: 'error', error: err.message });
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
