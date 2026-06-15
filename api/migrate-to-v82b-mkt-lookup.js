/**
 * api/migrate-to-v82b-mkt-lookup.js
 * V82.b — Creates marketing_category_lookup table and seeds from existing
 * contact_marketing_categories data.
 *
 * Separate from migrate-to-v82b.js because that already ran.
 * Safe to re-run (idempotent).
 *
 * GET  → status
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v82b_marketing_category_lookup';

async function ensureMigrationsTable() {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT now())`;
}

async function hasMigrationRun() {
  const r = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return r.length > 0;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    await ensureMigrationsTable();

    if (req.method === 'GET') {
      const already_ran = await hasMigrationRun();
      const tableExists = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'marketing_category_lookup'`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran,
        table_exists: tableExists.length > 0,
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`
        CREATE TABLE IF NOT EXISTS marketing_category_lookup (
          category   TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;

      // Seed from existing contact_marketing_categories
      const seeded = await sql`
        INSERT INTO marketing_category_lookup (category)
        SELECT DISTINCT category FROM contact_marketing_categories
        ON CONFLICT (category) DO NOTHING`;

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;

      const count = await sql`SELECT COUNT(*)::int AS n FROM marketing_category_lookup`;

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        categories_seeded: count[0].n,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
