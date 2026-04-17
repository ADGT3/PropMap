/**
 * api/finance-api.js  (V75)
 * Financial feasibility model storage — keyed by deal_id.
 *
 * During V75 stage 1 migration, existing property_financials rows get a
 * deal_id column populated equal to their pipeline_id (1:1 mapping). Both
 * columns remain and are indexed. Going forward the API reads/writes via
 * deal_id preferentially; pipeline_id continues to work as an alias so the
 * V74 frontend keeps working.
 *
 * GET    /api/finance-api?id=X              -> single model (X is deal_id, legacy pipeline_id also works)
 * GET    /api/finance-api                   -> all models
 * POST   /api/finance-api { id, data }      -> upsert (id = deal_id)
 * DELETE /api/finance-api?id=X              -> delete
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';

function getDb() {
  return neon(getDatabaseUrl());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  // Ensure table exists (idempotent — migration creates/alters this too)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS property_financials (
        pipeline_id  TEXT PRIMARY KEY,
        deal_id      TEXT,
        data         JSONB NOT NULL,
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`ALTER TABLE property_financials ADD COLUMN IF NOT EXISTS deal_id TEXT`;
  } catch (err) {
    return res.status(500).json({ error: 'DB init failed', detail: err.message });
  }

  // GET
  if (req.method === 'GET') {
    const { id } = req.query;
    try {
      if (id) {
        // Accept either deal_id or legacy pipeline_id
        const rows = await sql`
          SELECT pipeline_id, deal_id, data FROM property_financials
          WHERE deal_id = ${id} OR pipeline_id = ${id}
          LIMIT 1`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0].data);
      }
      const rows = await sql`
        SELECT pipeline_id, deal_id, data FROM property_financials
        ORDER BY updated_at DESC`;
      const out = {};
      rows.forEach(r => {
        // Key by deal_id preferentially (falls back to pipeline_id if missing)
        const key = r.deal_id || r.pipeline_id;
        out[key] = r.data;
      });
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ error: 'Read failed', detail: err.message });
    }
  }

  // POST — upsert keyed by deal_id (also writes pipeline_id = same value for back-compat)
  if (req.method === 'POST') {
    const { id, data } = req.body || {};
    if (!id || !data) return res.status(400).json({ error: 'id and data required' });
    try {
      const dataJson = JSON.stringify(data);
      await sql`
        INSERT INTO property_financials (pipeline_id, deal_id, data, updated_at)
        VALUES (${id}, ${id}, ${dataJson}::jsonb, NOW())
        ON CONFLICT (pipeline_id) DO UPDATE SET
          deal_id    = EXCLUDED.deal_id,
          data       = EXCLUDED.data,
          updated_at = NOW()`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Write failed', detail: err.message });
    }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await sql`DELETE FROM property_financials WHERE deal_id = ${id} OR pipeline_id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
