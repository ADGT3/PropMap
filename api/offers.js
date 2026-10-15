/**
 * api/offers.js
 * CRUD for offers. Linked to deal.
 *
 * GET    ?deal_id=X  → offers for that deal (newest first)
 * POST               → create
 * PUT                → update (id required)
 * DELETE ?id=N       → remove
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'pipeline')) return;

  try {
    if (req.method === 'GET') {
      const { deal_id } = req.query;
      if (!deal_id) return res.status(400).json({ error: 'deal_id required' });
      const rows = await sql`
        SELECT * FROM offers
        WHERE deal_id = ${deal_id}
        ORDER BY created_at DESC`;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.deal_id) return res.status(400).json({ error: 'deal_id required' });
      const rows = await sql`
        INSERT INTO offers (deal_id, price, settlement, deposits, status)
        VALUES (
          ${b.deal_id},
          ${b.price || null},
          ${b.settlement || null},
          ${JSON.stringify(b.deposits || [])}::jsonb,
          ${b.status || 'submitted'}
        )
        RETURNING *`;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: 'id required' });
      const rows = await sql`
        UPDATE offers SET
          price      = COALESCE(${b.price ?? null}, price),
          settlement = COALESCE(${b.settlement ?? null}, settlement),
          deposits   = COALESCE(${b.deposits ? JSON.stringify(b.deposits) : null}::jsonb, deposits),
          status     = COALESCE(${b.status ?? null}, status),
          updated_at = now()
        WHERE id = ${b.id}
        RETURNING *`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM offers WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[offers]', err);
    return res.status(500).json({ error: err.message });
  }
}
