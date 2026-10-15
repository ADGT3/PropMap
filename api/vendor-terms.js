/**
 * api/vendor-terms.js
 * CRUD for vendor_terms. Linked to deal and property.
 *
 * GET  ?deal_id=X     → terms for that deal (newest first)
 * GET  ?property_id=X → price history for that property (newest first)
 * POST                → create a snapshot
 * DELETE ?id=N        → remove a snapshot
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
      const { deal_id, property_id } = req.query;
      if (deal_id) {
        const rows = await sql`
          SELECT * FROM vendor_terms
          WHERE deal_id = ${deal_id}
          ORDER BY captured_at DESC`;
        return res.status(200).json(rows);
      }
      if (property_id) {
        const rows = await sql`
          SELECT vt.*, d.id AS deal_id
          FROM vendor_terms vt
          LEFT JOIN deals d ON d.id = vt.deal_id
          WHERE vt.property_id = ${property_id}
          ORDER BY vt.captured_at DESC`;
        return res.status(200).json(rows);
      }
      return res.status(400).json({ error: 'deal_id or property_id required' });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.deal_id) return res.status(400).json({ error: 'deal_id required' });
      const rows = await sql`
        INSERT INTO vendor_terms (deal_id, property_id, price, settlement, deposits, agent_name, agent_agency, captured_by)
        VALUES (
          ${b.deal_id},
          ${b.property_id || null},
          ${b.price || null},
          ${b.settlement || null},
          ${JSON.stringify(b.deposits || [])}::jsonb,
          ${b.agent_name || null},
          ${b.agent_agency || null},
          ${b.captured_by || null}
        )
        RETURNING *`;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM vendor_terms WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[vendor-terms]', err);
    return res.status(500).json({ error: err.message });
  }
}
