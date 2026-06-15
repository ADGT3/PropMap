/**
 * api/migrate-to-v82b-disciplines.js
 * V82.b — Creates disciplines table with rate_per_hour and seeds with defaults.
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

const MIGRATION_ID = 'v82b_disciplines_table';

const DISCIPLINES = [
  'Aboriginal Sensitivity','Accessibility','Acoustics','Architecture','Arborist','BCA',
  'Builder (Civil)','Builder (Construction)','Builder (Electrical)','Builder (Landscaping)',
  'Builder (Telco Contractor)','Builder (Water)','Building Maintenance','Civil','Council',
  'Demolition/HazMat','Dilapidation/Assessments','Ecology','Engineering - Civil/SW',
  'Engineering - Electrical','Engineering - Fire','Engineering - Hydraulic',
  'Engineering - Mechanical','Engineering - Structural','Engineering - Traffic',
  'Engineering - Vertical','Fencing','Finance','Fire Consultant','Geotechnical',
  'Hydraulics','Hygienist/Contamination','Interior Design','Labourer',
  'Landscape Architecture','Legal','Marketing','Operations Management (Childcare)',
  'Operations Management (Commercial)','Operations Management (Retail)',
  'Project Management','Property Manager','PCA','Quantity Surveyor (QS)','Sales',
  'Structural','Survey','Technology','Thermal/BASIX/Section J','Tree Clearing',
  'Valuation','Water Services/WSC',
];

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
        WHERE table_schema = 'public' AND table_name = 'disciplines'`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran,
        table_exists: tableExists.length > 0,
        disciplines_to_seed: DISCIPLINES.length,
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      await sql`
        CREATE TABLE IF NOT EXISTS disciplines (
          id            SERIAL PRIMARY KEY,
          label         TEXT           NOT NULL UNIQUE,
          rate_per_hour NUMERIC(10,2)  NOT NULL DEFAULT 150.00,
          sort_order    INTEGER        NOT NULL DEFAULT 999,
          active        BOOLEAN        NOT NULL DEFAULT true,
          created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
        )`;

      let so = 10;
      for (const label of DISCIPLINES) {
        await sql`
          INSERT INTO disciplines (label, rate_per_hour, sort_order)
          VALUES (${label}, 150.00, ${so})
          ON CONFLICT (label) DO NOTHING`;
        so += 10;
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;

      const count = await sql`SELECT COUNT(*)::int AS n FROM disciplines`;

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        disciplines_seeded: count[0].n,
        message: `Disciplines table created and seeded with ${count[0].n} rows at $150/hr.`,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
