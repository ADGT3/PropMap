/**
 * api/migrate-to-v76-7.js
 *
 * V76.7 — Add `state` column to properties table
 *
 *   Background:
 *     Until now, the `properties` table only stored `address` and `suburb` —
 *     no state field. Display code in map.js, kanban.js (cards + modal), and
 *     crm.js hardcoded "NSW" for the state suffix. This was a problem the
 *     moment any interstate property entered the system: the displayed
 *     "Suburb NSW" label was wrong even though the lat/lng (and therefore
 *     map navigation) was correct, leading to confusing UX where clicking
 *     a "NSW"-labelled card flew the map to Victoria.
 *
 *   Fix:
 *     1. Add `properties.state TEXT NOT NULL DEFAULT 'NSW'` (this script).
 *     2. Domain-sourced records now persist their state to the DB.
 *     3. Geocoded (map-click / search) records persist the geocoder's region.
 *     4. Display code uses `${p.state || 'NSW'}` instead of hardcoded.
 *     5. CRM Properties modal exposes State as an editable input so existing
 *        wrongly-NSW-stamped rows can be corrected manually by the user.
 *
 *   No backfill is performed — existing rows keep the DEFAULT 'NSW' value
 *     per user instruction. Manual cleanup happens via the CRM Properties
 *     modal as needed.
 *
 *   GET  → status report
 *   POST → run migration (admin, body { confirm: true })
 *
 *   Idempotent: re-running it after success is a no-op.
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

async function statusReport() {
  const hasColumn = await columnExists('properties', 'state');
  let totalRows = 0;
  let nswCount = 0;
  if (hasColumn) {
    const rows = await sql`SELECT state, COUNT(*)::int AS n FROM properties GROUP BY state`;
    totalRows = rows.reduce((s, r) => s + r.n, 0);
    nswCount  = rows.find(r => r.state === 'NSW')?.n || 0;
    return {
      state_column_present: true,
      total_rows: totalRows,
      breakdown: rows,
    };
  }
  const all = await sql`SELECT COUNT(*)::int AS n FROM properties`;
  return {
    state_column_present: false,
    total_rows: all[0]?.n || 0,
  };
}

async function runMigration() {
  const log = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      log.push({ step: name, ok: true, ...(r || {}) });
    } catch (err) {
      log.push({ step: name, ok: false, error: err.message });
      throw err;
    }
  };

  await step('add properties.state', async () => {
    if (!(await columnExists('properties', 'state'))) {
      await sql`ALTER TABLE properties ADD COLUMN state TEXT NOT NULL DEFAULT 'NSW'`;
      return { added: true };
    }
    return { skipped: 'already exists' };
  });

  return { log };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    if (req.query.check === '1') {
      try {
        const status = await statusReport();
        return res.status(200).json(status);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(200).json({
      message: 'V76.7 migration: add `state` column to properties. POST { confirm: true } to run. GET ?check=1 for status.',
    });
  }

  if (req.method === 'POST') {
    if (!requireAdmin(session, res)) return;
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Migration not confirmed. POST body must include { "confirm": true }.',
      });
    }
    try {
      const result = await runMigration();
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
