/**
 * api/pipeline.js
 * Vercel serverless function — property pipeline CRUD via Vercel Postgres (Neon).
 *
 * Endpoints:
 *   GET  /api/pipeline          — load all pipeline entries
 *   POST /api/pipeline          — save (upsert) one entry  { id, data }
 *   DELETE /api/pipeline?id=x   — remove one entry by id
 *
 * Environment variables (set in Vercel dashboard under Storage → Postgres):
 *   POSTGRES_URL  (automatically injected when you link a Vercel Postgres DB)
 *
 * Table is created automatically on first request if it doesn't exist.
 */

import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  // CORS — allow same-origin and localhost dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auto-create table on first use
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS pipeline (
        id          TEXT PRIMARY KEY,
        data        JSONB NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  } catch (err) {
    return res.status(500).json({ error: 'DB init failed', detail: err.message });
  }

  // ── GET — return all entries ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await sql`SELECT id, data, updated_at FROM pipeline ORDER BY data->>'addedAt' ASC`;
      // Reconstruct the { [id]: data } shape the frontend expects
      const result = {};
      rows.forEach(row => { result[row.id] = row.data; });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Read failed', detail: err.message });
    }
  }

  // ── POST — upsert one entry ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { id, data } = req.body || {};
    if (!id || !data) return res.status(400).json({ error: 'id and data required' });

    try {
      await sql`
        INSERT INTO pipeline (id, data, updated_at)
        VALUES (${id}, ${JSON.stringify(data)}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET data = EXCLUDED.data,
              updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Write failed', detail: err.message });
    }
  }

  // ── DELETE — remove one entry ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    try {
      await sql`DELETE FROM pipeline WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
